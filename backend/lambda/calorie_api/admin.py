import time
from decimal import Decimal, InvalidOperation

from .utils import (
    format_response,
    authenticate,
    dynamo,
    python_obj_to_dynamo_obj,
    dynamo_obj_to_python_obj,
    decimal_to_number,
    TABLE_NAME,
    GUID_REGEX,
)

# Every optional field review_route can correct, and how to validate it if
# (and only if) the caller actually included it — mirrors submit.py's
# required-field validation, just applied conditionally.
OPTIONAL_TEXT_FIELDS = ["name", "servingName"]
OPTIONAL_NUMERIC_FIELDS = ["servingQuantity", "calories", "fat", "carbohydrates", "protein"]


def _parse_decimal(value):
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


@authenticate
def get_pending_route(event, admin_phone, body):
    result = dynamo.query(
        TableName=TABLE_NAME,
        KeyConditionExpression="#key1 = :key1",
        FilterExpression="attribute_not_exists(approved)",
        ExpressionAttributeNames={"#key1": "key1"},
        ExpressionAttributeValues=python_obj_to_dynamo_obj({":key1": "submitted_food"}),
    )
    pending = [
        {k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(item).items()}
        for item in result.get("Items", [])
    ]
    return format_response(event=event, http_code=200, body={"pending": pending}, log_this=False)


@authenticate
def review_route(event, admin_phone, body):
    food_id = (body.get("id") or "").strip()
    approved = body.get("approved")

    if not GUID_REGEX.match(food_id):
        return format_response(event=event, http_code=400, body="A valid id is required")
    if not isinstance(approved, bool):
        return format_response(event=event, http_code=400, body="approved (true/false) is required")

    updates = {"approved": approved, "reviewedAt": int(time.time())}

    for field in OPTIONAL_TEXT_FIELDS:
        if field in body:
            value = (body.get(field) or "").strip()
            if not value:
                return format_response(event=event, http_code=400, body=f"{field} cannot be empty if provided")
            updates[field] = value

    for field in OPTIONAL_NUMERIC_FIELDS:
        if field in body:
            value = _parse_decimal(body.get(field))
            if value is None or (field == "servingQuantity" and value <= 0):
                return format_response(event=event, http_code=400, body=f"A valid {field} is required if provided")
            updates[field] = value

    # Every attribute aliased through a placeholder, not just DynamoDB's
    # known-reserved words (e.g. "name") — there are 500+ of them, so
    # aliasing everything sidesteps having to track which ones apply.
    expr_names = {}
    expr_values = {}
    set_clauses = []
    for i, (key, value) in enumerate(updates.items()):
        name_placeholder = f"#f{i}"
        value_placeholder = f":v{i}"
        expr_names[name_placeholder] = key
        expr_values[value_placeholder] = value
        set_clauses.append(f"{name_placeholder} = {value_placeholder}")

    dynamo.update_item(
        TableName=TABLE_NAME,
        Key=python_obj_to_dynamo_obj({"key1": "submitted_food", "key2": food_id}),
        UpdateExpression="SET " + ", ".join(set_clauses),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=python_obj_to_dynamo_obj(expr_values),
    )

    return format_response(event=event, http_code=200, body={"id": food_id, "approved": approved})


@authenticate
def export_route(event, admin_phone, body):
    result = dynamo.query(
        TableName=TABLE_NAME,
        KeyConditionExpression="#key1 = :key1",
        FilterExpression="#approved = :true AND (attribute_not_exists(#exported) OR #exported = :false)",
        ExpressionAttributeNames={"#key1": "key1", "#approved": "approved", "#exported": "exported"},
        ExpressionAttributeValues=python_obj_to_dynamo_obj({":key1": "submitted_food", ":true": True, ":false": False}),
    )
    items = [dynamo_obj_to_python_obj(item) for item in result.get("Items", [])]

    exported_foods = []
    for item in items:
        exported_foods.append(
            {
                "id": item["key2"],
                "name": item["name"],
                "servings": [
                    {
                        "name": item["servingName"],
                        "quantity": decimal_to_number(item["servingQuantity"]),
                        "calories": decimal_to_number(item["calories"]),
                        "fat": decimal_to_number(item["fat"]),
                        "carbohydrates": decimal_to_number(item["carbohydrates"]),
                        "protein": decimal_to_number(item["protein"]),
                    }
                ],
            }
        )
        dynamo.update_item(
            TableName=TABLE_NAME,
            Key=python_obj_to_dynamo_obj({"key1": "submitted_food", "key2": item["key2"]}),
            UpdateExpression="SET #exported = :true",
            ExpressionAttributeNames={"#exported": "exported"},
            ExpressionAttributeValues=python_obj_to_dynamo_obj({":true": True}),
        )

    return format_response(event=event, http_code=200, body=exported_foods, log_this=False)
