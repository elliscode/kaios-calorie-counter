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
                # in export_route's output. None for an anonymous submission —
                # review_route (calorie_api/admin.py) just skips the user_foods
                # sync-back in that case, same as it always has for admin-added
                # foods, which never had a submitting user either.
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
