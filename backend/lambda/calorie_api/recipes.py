import time
from decimal import Decimal

from .utils import (
    format_response,
    parse_body,
    parse_servings,
    parse_decimal,
    create_id,
    dynamo,
    TABLE_NAME,
    python_obj_to_dynamo_obj,
    dynamo_obj_to_python_obj,
    decimal_to_number,
)

# Generous — shared via SMS/email, may sit unopened for a while before the
# recipient gets to it.
SHARE_TTL_SECONDS = 180 * 24 * 60 * 60
# Sanity cap on an anonymous, unauthenticated write — same spirit as
# sync.py's MAX_SYNC_ITEMS, cheap insurance against abuse rather than a
# real expected limit.
MAX_SHARE_INGREDIENTS = 200


# boto3's DynamoDB serializer rejects native Python floats outright (it
# only accepts Decimal, unlike parse_servings' own field-by-field
# parse_decimal calls which only cover the top-level servings shape) —
# ingredients is a client-defined nested structure with numbers at
# arbitrary depth (each ingredient's referenceServing), so it needs a
# recursive sweep rather than a fixed set of named fields.
def _floats_to_decimal(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _floats_to_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_floats_to_decimal(v) for v in value]
    return value


# Public, no auth — recipes are local-first and work fully anonymously
# already (same as any other locally-created food), so sharing only ever
# needs data already in the sharer's own client state. Stores a frozen,
# fully self-contained snapshot — never a live reference into the owner's
# own user_recipe#{user_id} partition, which isn't independently
# addressable by anyone but its owner anyway. Every ingredient arrives
# already denormalized (see buildRecipeSharePayload in app.js), so
# importing on another device never depends on that device having any
# particular food/catalog state, including custom foods that only exist
# on the sharer's own device.
def share_recipe_route(event):
    body = parse_body(event.get("body"))
    name = (body.get("name") or "").strip()
    servings = parse_servings(body.get("servings"))
    ingredients = body.get("ingredients")
    servings_count = body.get("servingsCount")

    if not name:
        return format_response(event=event, http_code=400, body="name is required")
    if servings is None:
        return format_response(event=event, http_code=400, body="At least one valid serving is required")
    if not isinstance(ingredients, list) or not ingredients or len(ingredients) > MAX_SHARE_INGREDIENTS:
        return format_response(event=event, http_code=400, body="ingredients must be a non-empty list")
    if not isinstance(servings_count, (int, float)) or isinstance(servings_count, bool) or servings_count <= 0:
        return format_response(event=event, http_code=400, body="servingsCount must be a positive number")

    share_id = create_id(20)
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(
            {
                "key1": "shared_recipe",
                "key2": share_id,
                "name": name,
                "servings": servings,
                "ingredients": _floats_to_decimal(ingredients),
                "servingsCount": parse_decimal(servings_count),
                "expiration": int(time.time()) + SHARE_TTL_SECONDS,
            }
        ),
    )
    return format_response(event=event, http_code=200, body={"id": share_id})


def get_shared_recipe_route(event):
    body = parse_body(event.get("body"))
    share_id = (body.get("id") or "").strip()
    if not share_id:
        return format_response(event=event, http_code=400, body="A valid id is required")

    result = dynamo.get_item(
        TableName=TABLE_NAME, Key=python_obj_to_dynamo_obj({"key1": "shared_recipe", "key2": share_id})
    )
    if "Item" not in result:
        return format_response(event=event, http_code=404, body="This shared recipe is no longer available")

    item = {k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(result["Item"]).items()}
    return format_response(
        event=event,
        http_code=200,
        body={
            "name": item["name"],
            "servings": item["servings"],
            "ingredients": item["ingredients"],
            "servingsCount": item["servingsCount"],
        },
    )
