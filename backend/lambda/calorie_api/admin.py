import time
import uuid

from .utils import (
    format_response,
    authenticate,
    dynamo,
    python_obj_to_dynamo_obj,
    dynamo_obj_to_python_obj,
    decimal_to_number,
    parse_servings,
    create_upc_mapping,
    load_encrypted_collection,
    store_encrypted_collection,
    TABLE_NAME,
    GUID_REGEX,
)

# The only food-level (not serving-level) field review_route can correct —
# "servings" is handled separately below since it's a whole list, not a
# single scalar value like this. A food has no "upc" field of its own — see
# create_upc_mapping in utils.py for why that's tracked as a separate record.
OPTIONAL_TEXT_FIELDS = ["name"]

# Matches submit.py's own SUBMISSION_TTL_SECONDS — admin-added foods (see
# add_food_route below) land in the exact same 30-day-pending-review queue
# as an app user's submission, so they expire on the same schedule.
SUBMISSION_TTL_SECONDS = 30 * 24 * 60 * 60


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


# Same query shape as _query_submitted_foods, against the separate
# "upc_mapping" record type (see create_upc_mapping in utils.py) — kept as
# its own function rather than a shared/parameterized one since a mapping
# has no servings list to backfill and the two record types are reviewed
# from entirely separate sections of admin.html.
def _query_upc_mappings(filter_expression, expr_names=None, expr_values=None):
    names = {"#key1": "key1"}
    names.update(expr_names or {})
    values = {":key1": "upc_mapping"}
    values.update(expr_values or {})
    result = dynamo.query(
        TableName=TABLE_NAME,
        KeyConditionExpression="#key1 = :key1",
        FilterExpression=filter_expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=python_obj_to_dynamo_obj(values),
    )
    return [
        {k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(item).items()}
        for item in result.get("Items", [])
    ]


# Shared by get_pending_route (just to list them) and export_route (to
# additionally mark them exported) — approved, and not yet exported. Reused
# as-is by the upc_mapping routes below too, since both record types use the
# exact same approved/exported attribute shape.
APPROVED_NOT_EXPORTED_FILTER = "#approved = :true AND (attribute_not_exists(#exported) OR #exported = :false)"
APPROVED_NOT_EXPORTED_NAMES = {"#approved": "approved", "#exported": "exported"}
APPROVED_NOT_EXPORTED_VALUES = {":true": True, ":false": False}


# Admin-console equivalent of submit.py's submit_food_route — writes into
# the exact same submitted_food pending queue, with the same shape and TTL,
# so it goes through the normal Accept/Export path like any other
# submission. Deliberately skips submit_food_route's dual-write into a
# submitter's own user_foods collection, since there's no end-user account
# involved here — this is the admin adding a food directly, not a user.
#
# Doubles as "add a new serving size to an *existing* food": pass that
# food's real id as foodId (instead of leaving it out to get a fresh one)
# and servings containing only the new serving. The resulting pending item
# then holds just that one addition under the existing food's id — a future
# local-catalog merge can key on id and either append servings to an
# already-known food or add a whole new one, the same export shape either
# way.
@authenticate
def add_food_route(event, admin_phone, body):
    name = (body.get("name") or "").strip()
    servings = parse_servings(body.get("servings"))
    upc = (body.get("upc") or "").strip() or None
    food_id = (body.get("foodId") or "").strip() or str(uuid.uuid4())

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
                "photoKey": None,
                "status": "pending",
                "submittedAt": int(time.time()),
                "expiration": int(time.time()) + SUBMISSION_TTL_SECONDS,
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

    return format_response(event=event, http_code=200, body={"id": food_id})


# Direct UPC->(food, serving, amount) link, no new nutrition data involved —
# used when the admin maps a scanned UPC to a food + serving that already
# exists exactly as-is. All five fields required, unlike add_food_route's
# optional upc: a mapping missing any of these isn't a mapping at all.
@authenticate
def add_upc_mapping_route(event, admin_phone, body):
    # str()-wrapped, not just .strip()'d — servingQuantity in particular
    # arrives as a JSON number (not a string) from the Resolve UPC panel's
    # "Map UPC to:" button (it sends a food's existing serving.quantity
    # as-is), and .strip() on an int/float raises AttributeError -> 500.
    upc = str(body.get("upc") or "").strip()
    food_id = str(body.get("foodId") or "").strip()
    food_name = str(body.get("foodName") or "").strip()
    serving_name = str(body.get("servingName") or "").strip()
    serving_quantity = str(body.get("servingQuantity") or "").strip()

    if not upc or not food_id or not food_name or not serving_name or not serving_quantity:
        return format_response(
            event=event,
            http_code=400,
            body="upc, foodId, foodName, servingName, and servingQuantity are all required",
        )

    create_upc_mapping(
        upc=upc, food_id=food_id, food_name=food_name, serving_name=serving_name, serving_quantity=serving_quantity
    )
    return format_response(event=event, http_code=200, body={"upc": upc})


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
    # Bundled into this same response (rather than a separate route/call) so
    # admin.html's one loadPending() refresh keeps both the foods and the
    # UPC Mappings sections in sync after any action in either one.
    pending_upc_mappings = _query_upc_mappings("attribute_not_exists(approved)")
    approved_upc_mappings = _query_upc_mappings(
        APPROVED_NOT_EXPORTED_FILTER, APPROVED_NOT_EXPORTED_NAMES, APPROVED_NOT_EXPORTED_VALUES
    )
    return format_response(
        event=event,
        http_code=200,
        body={
            "pending": pending,
            "approved": approved,
            "pendingUpcMappings": pending_upc_mappings,
            "approvedUpcMappings": approved_upc_mappings,
        },
        log_this=False,
    )


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

    result = dynamo.update_item(
        TableName=TABLE_NAME,
        Key=python_obj_to_dynamo_obj({"key1": "submitted_food", "key2": food_id}),
        UpdateExpression="SET " + ", ".join(set_clauses),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=python_obj_to_dynamo_obj(expr_values),
        ReturnValues="ALL_NEW",
    )

    # Keep the original submitter's own synced copy (see submit_food_route's
    # dual-write into user_foods) matching whatever gets corrected here —
    # otherwise a name/servings fix made during review only ever shows up in
    # the export, never on the submitter's own device. Only submissions from
    # the app carry a userId at all (add_food_route's admin-created ones
    # don't — there's no end-user to sync back to), and only if that user
    # still has this food and hasn't deleted it locally in the meantime.
    if "name" in updates or "servings" in updates:
        updated_item = {k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(result["Attributes"]).items()}
        user_id = updated_item.get("userId")
        if user_id:
            user_foods = load_encrypted_collection("user_foods", user_id)
            existing = user_foods.get(food_id)
            if existing and not existing.get("deleted"):
                user_foods[food_id] = {
                    "name": updated_item["name"],
                    "servings": updated_item["servings"],
                    "updated": int(time.time()),
                    "deleted": False,
                }
                store_encrypted_collection("user_foods", user_id, user_foods)

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


# --- UPC mappings (separate section of admin.html) ---------------------------
# Same accept/reject/correct/export shape as the food routes above, but for
# the much simpler upc_mapping record (see create_upc_mapping in utils.py) —
# no servings list, so no OPTIONAL_TEXT_FIELDS-style loop is worth sharing.
UPC_MAPPING_OPTIONAL_FIELDS = ["foodId", "foodName", "servingName", "servingQuantity"]


@authenticate
def review_upc_mapping_route(event, admin_phone, body):
    upc = str(body.get("upc") or "").strip()
    approved = body.get("approved")

    if not upc:
        return format_response(event=event, http_code=400, body="A valid upc is required")
    if not isinstance(approved, bool):
        return format_response(event=event, http_code=400, body="approved (true/false) is required")

    updates = {"approved": approved, "reviewedAt": int(time.time())}

    # str()-wrapped for the same reason as add_upc_mapping_route above —
    # servingQuantity isn't guaranteed to arrive as a JSON string.
    for field in UPC_MAPPING_OPTIONAL_FIELDS:
        if field in body:
            value = str(body.get(field) or "").strip()
            if not value:
                return format_response(event=event, http_code=400, body=f"{field} cannot be empty if provided")
            updates[field] = value

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
        Key=python_obj_to_dynamo_obj({"key1": "upc_mapping", "key2": upc}),
        UpdateExpression="SET " + ", ".join(set_clauses),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=python_obj_to_dynamo_obj(expr_values),
    )

    return format_response(event=event, http_code=200, body={"upc": upc, "approved": approved})


@authenticate
def export_upc_mappings_route(event, admin_phone, body):
    items = _query_upc_mappings(
        APPROVED_NOT_EXPORTED_FILTER, APPROVED_NOT_EXPORTED_NAMES, APPROVED_NOT_EXPORTED_VALUES
    )

    exported_mappings = []
    for item in items:
        # foodName is denormalized onto the stored record purely for display
        # in this admin page — deliberately left out of the export, which is
        # exactly the {upc, foodId, servingName, servingQuantity} the
        # local-catalog import expects (the three things a barcode maps to,
        # plus the upc itself).
        exported_mappings.append(
            {
                "upc": item["upc"],
                "foodId": item["foodId"],
                "servingName": item["servingName"],
                "servingQuantity": item["servingQuantity"],
            }
        )
        dynamo.update_item(
            TableName=TABLE_NAME,
            Key=python_obj_to_dynamo_obj({"key1": "upc_mapping", "key2": item["upc"]}),
            UpdateExpression="SET #exported = :true",
            ExpressionAttributeNames={"#exported": "exported"},
            ExpressionAttributeValues=python_obj_to_dynamo_obj({":true": True}),
        )

    return format_response(event=event, http_code=200, body=exported_mappings, log_this=False)
