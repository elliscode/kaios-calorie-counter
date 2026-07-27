import time

from .utils import format_response, parse_body, parse_servings, python_obj_to_dynamo_obj, dynamo, TABLE_NAME, GUID_REGEX

SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


def submit_food_route(event):
    body = parse_body(event.get("body"))

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

    return format_response(event=event, http_code=200, body={"id": food_id}, log_this=False)
