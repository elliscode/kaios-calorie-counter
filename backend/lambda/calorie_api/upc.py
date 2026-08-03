import os
import re

from .utils import (
    format_response,
    parse_body,
    dynamo,
    python_obj_to_dynamo_obj,
    dynamo_obj_to_python_obj,
    decimal_to_number,
)

UPC_TABLE_NAME = os.environ.get("UPC_TABLE_NAME")


# Mirrors upc_cleaner in backend/data-prep/convert_for_kaios_barcode_dynamodb.py
# — the table's items were keyed using that exact normalization, so a lookup
# has to match it or a real UPC just won't be found.
def _normalize_upc(raw):
    digits = re.sub(r"\D", "", raw or "")
    while len(digits) < 12:
        digits = f"0{digits}"
    return digits


def lookup_upc_route(event):
    body = parse_body(event.get("body"))
    upc = _normalize_upc(body.get("upc"))
    if not upc:
        return format_response(event=event, http_code=400, body="A upc is required")

    result = dynamo.get_item(TableName=UPC_TABLE_NAME, Key=python_obj_to_dynamo_obj({"upc": upc}))
    if "Item" not in result:
        return format_response(event=event, http_code=404, body="No food found for this UPC")

    item = {k: decimal_to_number(v) for k, v in dynamo_obj_to_python_obj(result["Item"]).items()}
    return format_response(event=event, http_code=200, body=item)
