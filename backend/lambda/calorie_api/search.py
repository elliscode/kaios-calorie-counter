import os
import re

import boto3

from .utils import format_response, parse_body

SEARCH_BUCKET = os.environ.get("SEARCH_BUCKET")
SEARCH_FILE = os.environ.get("SEARCH_FILE")
SEARCH_LIMIT = int(os.environ.get("SEARCH_LIMIT", "100"))

s3 = boto3.client("s3")

# Populated lazily on first use, then reused for the life of the warm
# Lambda container — the backing file is ~455K rows (~30MB), too big to
# re-fetch/re-parse from S3 on every invocation.
_search_index = None  # {name: upc}
_search_rows = None  # [(name_normalized, name, upc), ...] — precomputed once
# so normalization isn't re-run on all 455K names on every single request.

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


def _load_search_index():
    global _search_index, _search_rows
    obj = s3.get_object(Bucket=SEARCH_BUCKET, Key=SEARCH_FILE)
    text = obj["Body"].read().decode("utf-8")
    index = {}
    for line in text.splitlines():
        if not line:
            continue
        upc, name = line.split("\t", 1)
        index[name] = upc  # last occurrence in the file wins on duplicate names
    _search_index = index
    _search_rows = [(_normalize_for_search(name), name, upc) for name, upc in index.items()]


def _get_search_rows():
    if _search_rows is None:
        _load_search_index()
    return _search_rows


# Mirrors the client's own match predicate exactly (renderSearchResults in
# frontend-v3/app.js) — case-insensitive, punctuation-insensitive substring
# match, no word-splitting, no minimum length — just scanning a much bigger
# (455K-row) list the device never downloads.
def search_route(event):
    body = parse_body(event.get("body"))
    query = _normalize_for_search(str(body.get("query") or "").strip())
    if not query:
        return format_response(event=event, http_code=200, body=[])

    rows = _get_search_rows()
    results = []
    for name_normalized, name, upc in rows:
        if query in name_normalized:
            results.append({"name": name, "upc": upc})
            if len(results) >= SEARCH_LIMIT:
                break
    return format_response(event=event, http_code=200, body=results)
