import time
from decimal import Decimal, InvalidOperation

from .utils import format_response, parse_body, python_obj_to_dynamo_obj, dynamo, TABLE_NAME, GUID_REGEX

SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


def _parse_decimal(value):
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def submit_food_route(event):
    body = parse_body(event.get("body"))

    food_id = (body.get("id") or "").strip()
    name = (body.get("name") or "").strip()
    serving_name = (body.get("servingName") or "").strip()
    serving_quantity = _parse_decimal(body.get("servingQuantity"))
    calories = _parse_decimal(body.get("calories"))
    fat = _parse_decimal(body.get("fat")) or Decimal(0)
    carbohydrates = _parse_decimal(body.get("carbohydrates")) or Decimal(0)
    protein = _parse_decimal(body.get("protein")) or Decimal(0)
    # The client already knows this — its own presigned-POST upload (see
    # calorie_api/presigned.py) used this exact key, f"{id}.{extension}".
    # This route never touches S3 or the photo bytes at all.
    photo_key = body.get("photoKey") or None

    if not GUID_REGEX.match(food_id):
        return format_response(event=event, http_code=400, body="A valid id is required")
    if not name:
        return format_response(event=event, http_code=400, body="name is required")
    if not serving_name:
        return format_response(event=event, http_code=400, body="servingName is required")
    if serving_quantity is None or serving_quantity <= 0:
        return format_response(event=event, http_code=400, body="A valid servingQuantity is required")
    if calories is None:
        return format_response(event=event, http_code=400, body="A valid calories value is required")

    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(
            {
                "key1": "submitted_food",
                "key2": food_id,
                "name": name,
                "servingQuantity": serving_quantity,
                "servingName": serving_name,
                "calories": calories,
                "fat": fat,
                "carbohydrates": carbohydrates,
                "protein": protein,
                "photoKey": photo_key,
                "status": "pending",
                "submittedAt": int(time.time()),
                "expiration": int(time.time()) + SUBMISSION_TTL_SECONDS,
            }
        ),
    )

    return format_response(event=event, http_code=200, body={"id": food_id}, log_this=False)
