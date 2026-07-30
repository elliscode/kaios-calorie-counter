import re
import time

from .utils import (
    format_response,
    authenticate_user,
    load_encrypted_collection,
    store_encrypted_collection,
    parse_servings,
    decimal_to_number,
)

# Same 120-day tombstone retention as kaios-shared-list's store_list.
DELETED_ITEM_RETENTION_DAYS = 4 * 30
DATE_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# New accounts are otherwise an open write-amplification vector — these are
# generous limits for real usage, cheap insurance against abuse.
MAX_SYNC_BODY_BYTES = 200_000
MAX_SYNC_ITEMS = 3000


# Ported from kaios-shared-list/backend/lambda/shared_list/list_merge.py's
# merge_list, generalized to work on any {id: {...fields, updated, deleted}}
# dict rather than one specific item schema. Whichever side has the newer
# "updated" timestamp wins as a whole unit — no field-level merging within
# an item — and the merged (not raw client) result is always what gets
# stored and returned, so the client is expected to replace its local copy
# with the response.
def merge_dict(client_items, server_items):
    client_items = client_items if isinstance(client_items, dict) else {}
    server_items = server_items if isinstance(server_items, dict) else {}
    merged = dict(server_items)
    for key, client_item in client_items.items():
        if not isinstance(client_item, dict):
            continue
        server_item = server_items.get(key)
        if server_item is None or client_item.get("updated", 0) > server_item.get("updated", 0):
            merged[key] = client_item
    return merged


def purge_old_tombstones(items, retention_days=DELETED_ITEM_RETENTION_DAYS):
    cutoff = int(time.time()) - retention_days * 24 * 60 * 60
    return {k: v for k, v in items.items() if not (v.get("deleted") and v.get("updated", 0) < cutoff)}


def _too_large(event, items):
    body_str = event.get("body") or ""
    return len(body_str) > MAX_SYNC_BODY_BYTES or len(items) > MAX_SYNC_ITEMS


@authenticate_user
def sync_foods_route(event, user_id, body):
    client_foods = body.get("foods")
    if not isinstance(client_foods, dict):
        return format_response(event=event, http_code=400, body="foods must be an object")
    if _too_large(event, client_foods):
        return format_response(event=event, http_code=400, body="Sync payload too large")

    # Deleted tombstones pass through as-is; anything else is held to the
    # same shape a real submission is (name + valid servings) so a synced
    # food can never be malformed — an item failing validation is dropped
    # rather than failing the whole request.
    valid_client_foods = {}
    for food_id, food in client_foods.items():
        if not isinstance(food, dict):
            continue
        if food.get("deleted"):
            valid_client_foods[food_id] = food
            continue
        servings = parse_servings(food.get("servings"))
        if servings is None or not food.get("name"):
            continue
        valid_client_foods[food_id] = {**food, "servings": decimal_to_number(servings)}

    server_foods = load_encrypted_collection("user_foods", user_id)
    merged = purge_old_tombstones(merge_dict(valid_client_foods, server_foods))
    store_encrypted_collection("user_foods", user_id, merged)
    return format_response(event=event, http_code=200, body={"foods": merged}, log_this=False)


@authenticate_user
def sync_diary_route(event, user_id, body):
    date = str(body.get("date") or "")
    entries = body.get("entries")
    if not DATE_REGEX.match(date):
        return format_response(event=event, http_code=400, body="A valid date (YYYY-MM-DD) is required")
    if not isinstance(entries, dict):
        return format_response(event=event, http_code=400, body="entries must be an object")
    if _too_large(event, entries):
        return format_response(event=event, http_code=400, body="Sync payload too large")

    # A call for one date never reads or writes any other date's item — the
    # user's explicit constraint that the server never sees more than a
    # single calendar date's worth of diary data in one request.
    diary_key = f"{user_id}#{date}"
    server_entries = load_encrypted_collection("user_diary", diary_key)
    merged = purge_old_tombstones(merge_dict(entries, server_entries))
    store_encrypted_collection("user_diary", diary_key, merged)
    return format_response(event=event, http_code=200, body={"date": date, "entries": merged}, log_this=False)


@authenticate_user
def sync_preferences_route(event, user_id, body):
    server_prefs = load_encrypted_collection("user_preferences", user_id)
    merged_prefs = dict(server_prefs)

    if "settings" in body:
        if not isinstance(body["settings"], dict):
            return format_response(event=event, http_code=400, body="settings must be an object")
        # Merged as a single-item dict (one key, "settings") so the whole
        # settings blob goes through the same newer-updated-wins codepath as
        # everything else, rather than a bespoke comparison.
        client_wrapper = {"settings": body["settings"]}
        server_wrapper = {"settings": server_prefs["settings"]} if "settings" in server_prefs else {}
        merged_prefs["settings"] = merge_dict(client_wrapper, server_wrapper)["settings"]

    for key in ("lastServings", "usageCounts"):
        if key in body:
            if not isinstance(body[key], dict):
                return format_response(event=event, http_code=400, body=f"{key} must be an object")
            if _too_large(event, body[key]):
                return format_response(event=event, http_code=400, body="Sync payload too large")
            merged_prefs[key] = purge_old_tombstones(merge_dict(body[key], server_prefs.get(key, {})))

    store_encrypted_collection("user_preferences", user_id, merged_prefs)
    return format_response(event=event, http_code=200, body=merged_prefs, log_this=False)
