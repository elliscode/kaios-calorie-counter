import time

from .utils import (
    format_response,
    parse_servings,
    python_obj_to_dynamo_obj,
    dynamo,
    TABLE_NAME,
    GUID_REGEX,
    authenticate_user,
    load_encrypted_collection,
    store_encrypted_collection,
    decimal_to_number,
)

SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


# Login-required — a deliberate spam gate on the moderation queue, since this
# used to be fully anonymous. Also closes the loop with presigned.py's
# presigned_post_route, gated the same way, so the whole "create a custom
# food" flow (photo upload included) requires a session end to end.
@authenticate_user
def submit_food_route(event, user_id, body):
    food_id = (body.get("id") or "").strip()
    name = (body.get("name") or "").strip()
    servings = parse_servings(body.get("servings"))
    # The client already knows this — its own presigned-POST upload (see
    # calorie_api/presigned.py) used this exact key, f"{id}.{extension}".
    # This route never touches S3 or the photo bytes at all.
    photo_key = body.get("photoKey") or None

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
                "photoKey": photo_key,
                "status": "pending",
                "submittedAt": int(time.time()),
                "expiration": int(time.time()) + SUBMISSION_TTL_SECONDS,
            }
        ),
    )

    # Dual-purpose: this same food also lands in the submitter's own synced
    # foods collection, immediately usable from their account on any device —
    # independent of whether an admin ever approves it into the shared
    # catalog above.
    user_foods = load_encrypted_collection("user_foods", user_id)
    user_foods[food_id] = {
        "name": name,
        "servings": decimal_to_number(servings),
        "updated": int(time.time()),
        "deleted": False,
    }
    store_encrypted_collection("user_foods", user_id, user_foods)

    return format_response(event=event, http_code=200, body={"id": food_id}, log_this=False)
