import time

from .utils import (
    format_response,
    parse_servings,
    python_obj_to_dynamo_obj,
    dynamo,
    TABLE_NAME,
    GUID_REGEX,
    optionally_authenticate_user,
    load_encrypted_collection,
    store_encrypted_collection,
    decimal_to_number,
    create_upc_mapping,
)

SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


# Anonymous submission is allowed on purpose — admin review is the actual
# spam gate on the moderation queue, not login. When a valid session *is*
# present, the submission still gets attached to that account (userId below,
# plus the user_foods dual-write) so it's usable from other devices too;
# without one, it's just a local-only food until an admin approves+exports it.
@optionally_authenticate_user
def submit_food_route(event, user_id, body):
    food_id = (body.get("id") or "").strip()
    name = (body.get("name") or "").strip()
    servings = parse_servings(body.get("servings"))
    # Not part of the app's UI yet — once barcode scanning lands there, a
    # scan-then-submit will pass the scanned code through here invisibly to
    # the user. A UPC never lives on the food item itself (see
    # create_upc_mapping) — it only ever produces a separate, admin-reviewed
    # mapping to this submission's own id + its first serving.
    upc = (body.get("upc") or "").strip() or None

    if not GUID_REGEX.match(food_id):
        return format_response(event=event, http_code=400, body="A valid id is required")
    if not name:
        return format_response(event=event, http_code=400, body="name is required")
    if servings is None:
        return format_response(
            event=event,
            http_code=400,
            body="At least one valid serving (name, quantity, calories) is required",
        )

    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(
            {
                "key1": "submitted_food",
                "key2": food_id,
                "name": name,
                "servings": servings,
                "status": "pending",
                "submittedAt": int(time.time()),
                "expiration": int(time.time()) + SUBMISSION_TTL_SECONDS,
                # Internal bookkeeping — like submittedAt/status, visible in the
                # raw /admin/pending payload (only the admin sees it) but never
                # in export_route's output. Unused by review_route (calorie_api/
                # admin.py) itself — there's no live admin-to-user channel; a
                # review's corrections only ever reach a device via the normal
                # export -> manifest.json -> catalog sync path.
                "userId": user_id,
            }
        ),
    )

    if upc:
        create_upc_mapping(
            upc=upc,
            food_id=food_id,
            food_name=name,
            serving_name=servings[0]["name"],
            serving_quantity=str(servings[0]["quantity"]),
        )

    # Dual-purpose: this same food also lands in the submitter's own synced
    # foods collection, immediately usable from their account on any device —
    # independent of whether an admin ever approves it into the shared
    # catalog above. Only when actually logged in — an anonymous submitter
    # has no account to sync to; their copy already exists purely locally
    # (see frontend-v3/app.js's submitNewFood, which writes it to IndexedDB
    # unconditionally before ever calling this route).
    if user_id:
        user_foods = load_encrypted_collection("user_foods", user_id)
        user_foods[food_id] = {
            "name": name,
            "servings": decimal_to_number(servings),
            "updated": int(time.time()),
            "deleted": False,
        }
        store_encrypted_collection("user_foods", user_id, user_foods)

    return format_response(event=event, http_code=200, body={"id": food_id}, log_this=False)


# Cheap insurance against abuse on a route with no login gate — same
# reasoning as sync.py's MAX_SYNC_BODY_BYTES/MAX_SYNC_ITEMS: generous for
# real usage, just bounds how much garbage a single request can write.
MAX_UPC_MAPPING_FIELD_LENGTH = 300


# Anonymous, end-user-facing equivalent of admin.py's add_upc_mapping_route —
# reached from the app's "Match this barcode to an existing food" flow
# (frontend-v3/app.js) when a scanned UPC has no already-known local
# mapping. Writes into the exact same "upc_mapping" pending-review queue
# admin.html's UPC Mappings section already handles, so a proposal from here
# is reviewed by an admin (same spam gate submit_food_route above already
# relies on) before it can ever reach another device via export. No
# verification that foodId/servingName/servingQuantity correspond to
# something real is done here — matching add_upc_mapping_route's own
# existing trust model, since there's no queryable "current catalog" table
# to check them against (the catalog only ever exists as static exported
# JSON, never re-imported into DynamoDB). The one thing genuinely worth
# adding beyond that admin-only route's own validation is a bound on field
# lengths, since this version is reachable by anyone, not just the one
# logged-in admin.
@optionally_authenticate_user
def submit_upc_mapping_route(event, user_id, body):
    upc = str(body.get("upc") or "").strip()
    food_id = str(body.get("foodId") or "").strip()
    food_name = str(body.get("foodName") or "").strip()
    serving_name = str(body.get("servingName") or "").strip()
    serving_quantity = str(body.get("servingQuantity") if body.get("servingQuantity") is not None else "").strip()

    if not upc or not food_id or not food_name or not serving_name or not serving_quantity:
        return format_response(
            event=event,
            http_code=400,
            body="upc, foodId, foodName, servingName, and servingQuantity are all required",
        )
    if not GUID_REGEX.match(food_id):
        return format_response(event=event, http_code=400, body="A valid foodId is required")
    if max(len(upc), len(food_id), len(food_name), len(serving_name), len(serving_quantity)) > MAX_UPC_MAPPING_FIELD_LENGTH:
        return format_response(event=event, http_code=400, body="One or more fields is too long")

    create_upc_mapping(
        upc=upc,
        food_id=food_id,
        food_name=food_name,
        serving_name=serving_name,
        serving_quantity=serving_quantity,
        user_id=user_id,
    )
    return format_response(event=event, http_code=200, body={"upc": upc}, log_this=False)
