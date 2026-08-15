import re
import time

from .utils import (
    format_response,
    authenticate_user,
    load_encrypted_collection,
    store_encrypted_collection,
    query_encrypted_partition,
    delete_encrypted_item,
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


# DynamoDB TTL for a single row: a tombstone always gets one (same
# retention window purge_old_tombstones already enforces at the
# application level, measured from its own "deleted at" timestamp), so an
# expired tombstone is guaranteed to eventually get swept by DynamoDB
# itself even if this partition never gets synced again to trigger the
# purge below. A live (non-deleted) item only gets one if the caller passes
# inactivity_ttl_days — lastServings/usageCounts use this so a food you
# haven't logged in a while eventually drops out entirely, rather than
# keeping every food ever touched forever; custom foods/recipes never pass
# this, since that's real content the user created, not a cache of recent
# activity. Either way, the window slides forward from the item's own
# "updated" timestamp — re-touching a row (logging that food again) is what
# refreshes it, not merely syncing at all.
def _item_expiration(item, inactivity_ttl_days=None):
    if item.get("deleted"):
        return item.get("updated", 0) + DELETED_ITEM_RETENTION_DAYS * 24 * 60 * 60
    if inactivity_ttl_days is not None:
        return item.get("updated", 0) + inactivity_ttl_days * 24 * 60 * 60
    return None


# Generic per-item sync for any {id: {...fields, updated, deleted}}
# collection stored one-row-per-id under a single partition (key1) — the
# per-user custom foods, recipes, usageCounts, and lastServings collections
# all have this exact shape. Replaces the old "load one whole-collection
# blob, merge in Python, write the whole blob back" pattern (still used by
# sync_diary_route, which doesn't need this — see its own comment) — this
# only ever writes/deletes the rows that actually changed, so a sync call's
# cost is proportional to what changed, not to the account's entire
# history, and no single row can approach DynamoDB's item size cap. Returns
# the full merged {id: item} dict, same contract callers already expect
# from the old whole-blob return value.
def sync_partition(key1, client_items, inactivity_ttl_days=None):
    server_items = query_encrypted_partition(key1)
    changed = {}
    for item_id, client_item in client_items.items():
        server_item = server_items.get(item_id)
        if server_item is None or client_item.get("updated", 0) > server_item.get("updated", 0):
            changed[item_id] = client_item
    merged = purge_old_tombstones({**server_items, **changed})
    for item_id, item in changed.items():
        if item_id not in merged:
            continue  # not written at all — it's already past its own expiration
        store_encrypted_collection(key1, item_id, item, expiration=_item_expiration(item, inactivity_ttl_days))
    for item_id in set(server_items) - set(merged):
        delete_encrypted_item(key1, item_id)
    return merged


# One-time, self-healing fan-out of the legacy single-item "user_foods"
# blob into per-food/per-recipe rows — checked on every call but a cheap
# no-op (one GetItem returning nothing) once it's already run for an
# account. Idempotent if interrupted partway: the legacy item is only
# deleted after every row from it has been written, so a retry just
# re-writes the same rows rather than losing or duplicating anything.
def _migrate_legacy_foods_blob(user_id):
    legacy = load_encrypted_collection("user_foods", user_id)
    if not legacy:
        return
    for food_id, item in legacy.items():
        key1 = f"user_recipe#{user_id}" if item.get("type") == "recipe" else f"user_food#{user_id}"
        store_encrypted_collection(key1, food_id, item, expiration=_item_expiration(item))
    delete_encrypted_item("user_foods", user_id)


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

    _migrate_legacy_foods_blob(user_id)

    # Custom foods and recipes live in their own partitions (a tombstone
    # keeps whatever "type" its original record had — dbSoftDeleteFood in
    # app.js only flips deleted/updated, every other field survives — so a
    # deleted recipe's tombstone still routes to user_recipe#, not
    # user_food#).
    client_recipes = {k: v for k, v in valid_client_foods.items() if v.get("type") == "recipe"}
    client_plain_foods = {k: v for k, v in valid_client_foods.items() if v.get("type") != "recipe"}
    merged_foods = sync_partition(f"user_food#{user_id}", client_plain_foods)
    merged_recipes = sync_partition(f"user_recipe#{user_id}", client_recipes)

    return format_response(
        event=event, http_code=200, body={"foods": {**merged_foods, **merged_recipes}}, log_this=False
    )


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


# One-time, self-healing fan-out of user_preferences' legacy
# lastServings/usageCounts fields into per-food rows — same idempotent
# "cheap no-op once already migrated" shape as _migrate_legacy_foods_blob.
# settings stays in the user_preferences item (small, fixed-shape, not
# growing per-food) — this only ever rewrites that item to strip the two
# migrated fields out of it, never deletes it outright.
def _migrate_legacy_preference_fields(user_id):
    legacy = load_encrypted_collection("user_preferences", user_id)
    if "lastServings" not in legacy and "usageCounts" not in legacy:
        return
    for food_id, item in (legacy.get("lastServings") or {}).items():
        store_encrypted_collection(
            f"user_last_serving#{user_id}", food_id, item,
            expiration=_item_expiration(item, inactivity_ttl_days=DELETED_ITEM_RETENTION_DAYS),
        )
    for food_id, item in (legacy.get("usageCounts") or {}).items():
        store_encrypted_collection(
            f"user_usage_count#{user_id}", food_id, item,
            expiration=_item_expiration(item, inactivity_ttl_days=DELETED_ITEM_RETENTION_DAYS),
        )
    store_encrypted_collection("user_preferences", user_id, {"settings": legacy.get("settings", {})})


@authenticate_user
def sync_preferences_route(event, user_id, body):
    # Validate everything up front, same as before this rewrite — so a bad
    # usageCounts never leaves a partial write behind after a good
    # lastServings/settings already went through.
    if "settings" in body and not isinstance(body["settings"], dict):
        return format_response(event=event, http_code=400, body="settings must be an object")
    if "settings" in body and _too_large(event, body["settings"]):
        return format_response(event=event, http_code=400, body="Sync payload too large")
    for key in ("lastServings", "usageCounts"):
        if key in body:
            if not isinstance(body[key], dict):
                return format_response(event=event, http_code=400, body=f"{key} must be an object")
            if _too_large(event, body[key]):
                return format_response(event=event, http_code=400, body="Sync payload too large")

    _migrate_legacy_preference_fields(user_id)
    server_prefs = load_encrypted_collection("user_preferences", user_id)  # now just {"settings": {...}}
    merged_prefs = {"settings": server_prefs.get("settings", {})}

    if "settings" in body:
        # Merged as a single-item dict (one key, "settings") so the whole
        # settings blob goes through the same newer-updated-wins codepath as
        # everything else, rather than a bespoke comparison.
        client_wrapper = {"settings": body["settings"]}
        server_wrapper = {"settings": merged_prefs["settings"]}
        merged_prefs["settings"] = merge_dict(client_wrapper, server_wrapper)["settings"]
        store_encrypted_collection("user_preferences", user_id, {"settings": merged_prefs["settings"]})

    # Both collections expire after DELETED_ITEM_RETENTION_DAYS of
    # inactivity (not just on delete) — a food you haven't logged in that
    # long drops its remembered last-used serving and its usage-count
    # ranking boost, rather than being kept forever. The window slides
    # forward each time that food is actually logged again (see
    # _item_expiration).
    for key, key1_prefix in (("lastServings", "user_last_serving"), ("usageCounts", "user_usage_count")):
        client_items = body[key] if key in body else {}
        merged_prefs[key] = sync_partition(
            f"{key1_prefix}#{user_id}", client_items, inactivity_ttl_days=DELETED_ITEM_RETENTION_DAYS
        )

    return format_response(event=event, http_code=200, body=merged_prefs, log_this=False)
