import base64
import json
import os
from email import message_from_bytes
from email.message import Message

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from .logger import log

DOMAIN_NAMES = os.environ.get("DOMAIN_NAMES", "").split(",")
TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME")
PHOTOS_BUCKET_NAME = os.environ.get("PHOTOS_BUCKET_NAME")

dynamo = boto3.client("dynamodb")
s3 = boto3.client("s3")


def has_invalid_domain(event):
    return "origin" not in event["headers"] or event["headers"]["origin"].rstrip("/") not in DOMAIN_NAMES


def get_event_path(event):
    req_ctx = event.get("requestContext") or {}
    event_path = event.get("path")
    if not event_path:
        http_ctx = req_ctx.get("http") or {}
        event_path = http_ctx.get("path", "")
        stage = req_ctx.get("stage", "")
        event_path = event_path.removeprefix(f"/{stage}")
    return event_path


def get_request_metadata(event):
    try:
        req_ctx = event.get("requestContext") or {}
        http_ctx = req_ctx.get("http") or {}
        identity = req_ctx.get("identity") or {}
        return {
            "path": get_event_path(event),
            "origin": (event.get("headers") or {}).get("origin"),
            "sourceIp": identity.get("sourceIp") or http_ctx.get("sourceIp"),
            "userAgent": identity.get("userAgent") or http_ctx.get("userAgent"),
        }
    except Exception:
        return {}


def format_response(event, http_code, body, headers=None, log_this=True):
    metadata = get_request_metadata(event)
    if isinstance(body, str):
        body = {"message": body}
    if "origin" in event["headers"] and event["headers"]["origin"].rstrip("/") in DOMAIN_NAMES:
        domain_name = event["headers"]["origin"]
    else:
        log(metadata, f'Invalid origin {event["headers"].get("origin")}')
        http_code = 403
        body = {"message": "Forbidden"}
        domain_name = "*"
    all_headers = {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": domain_name,
        "Access-Control-Allow-Methods": "POST",
    }
    if headers is not None:
        all_headers.update(headers)
    if log_this:
        log(metadata, http_code, body)
    else:
        log(metadata, http_code)
    return {
        "statusCode": http_code,
        "body": json.dumps(body),
        "headers": all_headers,
    }


def path_equals(event, method, path):
    event_path = get_event_path(event)
    event_method = event.get("httpMethod", event.get("requestContext", {}).get("http", {}).get("method"))
    return event_method == method and (event_path == path or event_path == path + "/" or path == "*")


def dynamo_obj_to_python_obj(dynamo_obj: dict) -> dict:
    deserializer = TypeDeserializer()
    return {k: deserializer.deserialize(v) for k, v in dynamo_obj.items()}


def python_obj_to_dynamo_obj(python_obj: dict) -> dict:
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in python_obj.items()}


def _get_content_disposition_params(part: Message):
    # part.get(...) can return an email.header.Header instance instead of a
    # plain str (e.g. when the raw header needed special decoding) — Header
    # doesn't support .split(), so always coerce to str first.
    disposition = str(part.get("Content-Disposition", ""))
    params = {}
    for chunk in disposition.split(";")[1:]:
        chunk = chunk.strip()
        if "=" in chunk:
            key, _, value = chunk.partition("=")
            params[key.strip().lower()] = value.strip().strip('"')
    return params


def parse_multipart(event):
    """
    Parses an API Gateway event carrying a multipart/form-data body into
    (fields, photo). `fields` is a {name: value} dict of the plain text
    parts. `photo` is None, or {filename, content_type, bytes} for the file
    part named "photo" if one was attached.

    multipart/form-data is MIME multipart under the hood, so this leans on
    the stdlib `email` package to do the actual boundary-splitting rather
    than hand-rolling one — Python dropped the old `cgi` module (which used
    to do this) in 3.13.
    """
    content_type_header = event["headers"].get("content-type", "")
    raw_body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body_bytes = base64.b64decode(raw_body)
    else:
        body_bytes = raw_body.encode("utf-8")

    # Reconstruct a standalone MIME message: a Content-Type header (with the
    # boundary from the actual request) followed by the raw multipart body.
    header_bytes = f"Content-Type: {content_type_header}\r\n\r\n".encode("utf-8")
    message = message_from_bytes(header_bytes + body_bytes)

    fields = {}
    photo = None
    if message.is_multipart():
        for part in message.get_payload():
            params = _get_content_disposition_params(part)
            name = params.get("name")
            if not name:
                continue
            if "filename" in params and params["filename"]:
                photo = {
                    "filename": params["filename"],
                    "content_type": part.get_content_type(),
                    "bytes": part.get_payload(decode=True),
                }
            else:
                payload = part.get_payload(decode=True)
                fields[name] = payload.decode("utf-8") if payload is not None else ""
    return fields, photo
