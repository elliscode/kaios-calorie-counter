import time

from .utils import (
    format_response,
    authenticate,
    dynamo,
    python_obj_to_dynamo_obj,
    dynamo_obj_to_python_obj,
    decimal_to_number,
    parse_servings,
    TABLE_NAME,
    GUID_REGEX,
)

# The only food-level (not serving-level) field review_route can correct —
# "servings" is handled separately below since it's a whole list, not a
# single scalar value like this.
OPTIONAL_TEXT_FIELDS = ["name"]


# Pre-multi-serving submissions were stored as flat servingQuantity/
# servingName/calories/fat/carbohydrates/protein fields rather than a
# "servings" list. Backfilling it here (read-time only, never written back)
# means get_pending_route/export_route only ever have to deal with one
# shape, regardless of how old a still-pending submission is.
def _with_servings_backfill(item):
    if "servings" not in item:
        item["servings"] = [
            {
                "name": item.pop("servingName", None),
                "quantity": item.pop("servingQuantity", None),
                "calories": item.pop("calories", None),
                "fat": item.pop("fat", 0),
                "carbohydrates": item.pop("carbohydrates", 0),
                "protein": item.pop("protein", 0),
                "caffeine": item.pop("caffeine", 0),
            }
        ]
    return item


def _query_submitted_foods(filter_expression, expr_names=None, expr_values=None):
    names = {"#key1": "key1"}
    names.update(expr_names or {})
    values = {":key1": "submitted_food"}
    values.update(expr_values or {})
    result = dynamo.query(
        TableName=TABLE_NAME,
        KeyConditionExpression="#key1 = :key1",
        FilterExpression=filter_expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=python_obj_to_dynamo_obj(values),
    )
    return [
        _with_servings_backfill({k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(item).items()})
        for item in result.get("Items", [])
    ]


# Shared by get_pending_route (just to list them) and export_route (to
# additionally mark them exported) — approved, and not yet exported.
APPROVED_NOT_EXPORTED_FILTER = "#approved = :true AND (attribute_not_exists(#exported) OR #exported = :false)"
APPROVED_NOT_EXPORTED_NAMES = {"#approved": "approved", "#exported": "exported"}
APPROVED_NOT_EXPORTED_VALUES = {":true": True, ":false": False}


@authenticate
def get_pending_route(event, admin_phone, body):
    pending = _query_submitted_foods("attribute_not_exists(approved)")
    # Approved-but-not-yet-exported items stay visible (underneath the
    # awaiting-review queue) so there's a record of what's about to go out
    # next export — rejected (approved: false) and already-exported items
    # are the only two states that ever disappear from this page for good.
    approved = _query_submitted_foods(
        APPROVED_NOT_EXPORTED_FILTER, APPROVED_NOT_EXPORTED_NAMES, APPROVED_NOT_EXPORTED_VALUES
    )
    return format_response(event=event, http_code=200, body={"pending": pending, "approved": approved}, log_this=False)


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

    if "servings" in body:
        servings = parse_servings(body.get("servings"))
        if servings is None:
            return format_response(
                event=event,
                http_code=400,
                body="Each serving needs a valid name, quantity, and calories",
            )
        updates["servings"] = servings

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
    items = _query_submitted_foods(
        APPROVED_NOT_EXPORTED_FILTER, APPROVED_NOT_EXPORTED_NAMES, APPROVED_NOT_EXPORTED_VALUES
    )

    exported_foods = []
    for item in items:
        exported_foods.append({"id": item["key2"], "name": item["name"], "servings": item["servings"]})
        dynamo.update_item(
            TableName=TABLE_NAME,
            Key=python_obj_to_dynamo_obj({"key1": "submitted_food", "key2": item["key2"]}),
            UpdateExpression="SET #exported = :true",
            ExpressionAttributeNames={"#exported": "exported"},
            ExpressionAttributeValues=python_obj_to_dynamo_obj({":true": True}),
        )

    return format_response(event=event, http_code=200, body=exported_foods, log_this=False)
