import os
import pickle
import re
import time

import boto3

from .utils import format_response, parse_body

SEARCH_BUCKET = os.environ.get("SEARCH_BUCKET")
# Names the pickle blob in S3 (backend/data-prep/output_search_index.pkl),
# not the .tsv it's built from — see build_search_index() in
# convert_for_kaios_barcode_dynamodb.py.
SEARCH_FILE = os.environ.get("SEARCH_FILE")
SEARCH_LIMIT = int(os.environ.get("SEARCH_LIMIT", "100"))

s3 = boto3.client("s3")

# Populated lazily on first use, then reused for the life of the warm
# Lambda container — the backing file is ~455K rows (~30MB), too big to
# re-fetch/re-parse from S3 on every invocation.
_search_rows = None  # [(name_tokens, name, upc), ...] — comes pre-deduped
# and pre-tokenized straight out of the pickle blob (see
# backend/data-prep/convert_for_kaios_barcode_dynamodb.py's
# build_search_index), so cold start does one deserialize instead of
# parsing/deduping 455K lines of text every time.

# Mirrors frontend-v3/app.js's SEARCH_PUNCTUATION_REGEX/normalizeForSearch
# exactly — punctuation stripped (not replaced with a space) from both the
# query and the candidate name before matching, so e.g. "moms" matches
# "Mom's". Kept in sync by hand (no shared source between JS and Python) —
# see that file's comment for why this is a static character class rather
# than \p{L}-style Unicode regex classes.
_PUNCTUATION_RE = re.compile(r"[.,/#!$%^&*;:{}=\-_`~()'\"?\[\]\\|<>+@]")
_WHITESPACE_RE = re.compile(r"\s+")


# Punctuation is stripped outright (not replaced with a space), which can
# leave a run of two spaces behind where one used to sit next to it (e.g.
# "Mac & Cheese" -> "mac  cheese") — collapsed back down to one so a
# naturally single-spaced query like "mac cheese" still substring-matches.
def _normalize_for_search(s):
    return _WHITESPACE_RE.sub(" ", _PUNCTUATION_RE.sub("", s.lower())).strip()


def _tokenize(s):
    return [t for t in _normalize_for_search(s).split(" ") if t]


# Mirrors frontend-v3/app.js's matchesSearchTokens exactly — every query
# token must appear as a substring of *some* token in the candidate name,
# not the same position, not the whole phrase as one contiguous substring.
# Fixes cases like "hershey special dark" vs. "Hershey's Special Dark"
# (stripping the apostrophe alone still leaves an extra "s" in the way of a
# whole-string substring match) and makes word order irrelevant.
def _tokens_match(query_tokens, name_tokens):
    return all(any(qt in nt for nt in name_tokens) for qt in query_tokens)


# Mirrors frontend-v3/app.js's searchMatchScore exactly — ratio of how many
# words were typed to how many unique words are in the candidate name.
# Every candidate reaching this function has already passed _tokens_match
# (every query token found somewhere) — this only decides ORDER, never
# inclusion. A higher score means a tighter, less-diluted match and sorts
# first.
def _match_score(query_tokens, name_tokens):
    unique_count = len(set(name_tokens))
    return len(query_tokens) / unique_count if unique_count else 0


def _load_search_index():
    global _search_rows

    start = time.perf_counter()

    obj = s3.get_object(Bucket=SEARCH_BUCKET, Key=SEARCH_FILE)
    print(f"S3 get_object: {time.perf_counter() - start:.3f}s")

    raw = obj["Body"].read()
    print(f"Download/read: {time.perf_counter() - start:.3f}s")

    _search_rows = pickle.loads(raw)
    print(f"Unpickle rows: {time.perf_counter() - start:.3f}s")


def _get_search_rows():
    if _search_rows is None:
        _load_search_index()
    return _search_rows


# Mirrors the client's own match predicate exactly (renderSearchResults in
# frontend-v3/app.js) — case-insensitive, punctuation-insensitive,
# word-order-independent token matching, no minimum length — scanning the
# full 455K-row list the device never downloads and ranking every match by
# _match_score before slicing to SEARCH_LIMIT. No early-exit: which 100
# results are the *best* can't be known without scoring every match first
# (benchmarked at 0.2-0.4s worst case against the real data file, including
# single-character queries that match a large fraction of the catalog).
def search_route(event):
    body = parse_body(event.get("body"))
    if body.get("action") == "warm":
        _get_search_rows()
        return format_response(event=event, http_code=200, body={"warmed": True})

    query_tokens = _tokenize(str(body.get("query") or "").strip())
    if not query_tokens:
        return format_response(event=event, http_code=200, body=[])

    rows = _get_search_rows()
    matches = []
    for name_tokens, name, upc in rows:
        if _tokens_match(query_tokens, name_tokens):
            matches.append((_match_score(query_tokens, name_tokens), name, upc))
    matches.sort(key=lambda m: -m[0])  # stable: ties keep original file-scan order
    results = [{"name": name, "upc": upc} for _, name, upc in matches[:SEARCH_LIMIT]]
    return format_response(event=event, http_code=200, body=results)
