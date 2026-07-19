import mimetypes
import re
import time
from decimal import Decimal, InvalidOperation

from .utils import format_response, parse_multipart, python_obj_to_dynamo_obj, dynamo, s3, TABLE_NAME, PHOTOS_BUCKET_NAME

GUID_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def _parse_decimal(value):
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def submit_food_route(event):
    fields, photo = parse_multipart(event)

    food_id = (fields.get("id") or "").strip()
    name = (fields.get("name") or "").strip()
    serving_name = (fields.get("servingName") or "").strip()
    serving_quantity = _parse_decimal(fields.get("servingQuantity"))
    calories = _parse_decimal(fields.get("calories"))
    fat = _parse_decimal(fields.get("fat")) or Decimal(0)
    carbohydrates = _parse_decimal(fields.get("carbohydrates")) or Decimal(0)
    protein = _parse_decimal(fields.get("protein")) or Decimal(0)

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

    photo_key = None
    if photo and photo.get("bytes"):
        extension = mimetypes.guess_extension(photo["content_type"]) or ""
        photo_key = f"{food_id}{extension}"
        s3.put_object(
            Bucket=PHOTOS_BUCKET_NAME,
            Key=photo_key,
            Body=photo["bytes"],
            ContentType=photo["content_type"],
        )

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
            }
        ),
    )

    return format_response(event=event, http_code=200, body={"id": food_id}, log_this=False)
