import json
import os
import re
import secrets
import time
from decimal import Decimal
from urllib.parse import parse_qsl

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from .logger import log

DOMAIN_NAMES = os.environ.get("DOMAIN_NAMES", "").split(",")
TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME")
PHOTOS_BUCKET_NAME = os.environ.get("PHOTOS_BUCKET_NAME")
# A dedicated IAM identity's static credentials, used only to sign presigned
# S3 POST/GET URLs (see get_presigned_s3_client / calorie_api/presigned.py) —
# deliberately NOT the Lambda's own execution role, so a presigned URL's
# permissions are scoped to exactly what this identity can do, independent of
# whatever the Lambda itself is allowed to do. Shared across the user's other
# "dumbphone apps" projects — this project's bucket is just added to it.
PRESIGNED_AWS_ACCESS_KEY_ID = os.environ.get("PRESIGNED_AWS_ACCESS_KEY_ID")
PRESIGNED_AWS_SECRET_ACCESS_KEY = os.environ.get("PRESIGNED_AWS_SECRET_ACCESS_KEY")
# Admin moderation login (see login_route/otp_route) — a single hardcoded
# phone number, not a general user system, since there's only ever one
# legitimate admin. SMS is sent through an already-deployed, project-agnostic
# SQS-triggered Twilio Lambda (sibling project aws-lambda-twilio) — this
# queue URL points at that *same* existing queue, no new queue/consumer
# needed. Ported from kaios-t9-wizard/backend/lambda/t9_wizard/utils.py.
ADMIN_PHONE = os.environ.get("ADMIN_PHONE")
SMS_SQS_QUEUE_URL = os.environ.get("SMS_SQS_QUEUE_URL")
ADMIN_COOKIE_NAME = "calorie-counter-admin-token"
# Leading-dot wildcard — admin.html is served from calories.elliscode.com,
# the API from api.calories.elliscode.com, and a Set-Cookie response can
# only set a Domain that domain-matches the host that sent it. The wildcard
# is what lets one cookie, set by the API subdomain, actually get sent back
# by the browser on both.
ADMIN_COOKIE_DOMAIN = ".calories.elliscode.com"

digits = "0123456789"
lowercase_letters = "abcdefghijklmnopqrstuvwxyz"
uppercase_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# Shared by submit.py, presigned.py, and admin.py — a food's id is always a
# client-generated GUID (see frontend-v3/app.js's generateGuid()).
GUID_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

dynamo = boto3.client("dynamodb")
sqs = boto3.client("sqs")


def get_presigned_s3_client():
    return boto3.client(
        "s3",
        aws_access_key_id=PRESIGNED_AWS_ACCESS_KEY_ID,
        aws_secret_access_key=PRESIGNED_AWS_SECRET_ACCESS_KEY,
    )


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
        "Access-Control-Allow-Credentials": "true",
        # Without this, admin.html's fetch() can't read the x-csrf-token
        # header off the login response — browsers hide non-simple response
        # headers cross-origin unless the server explicitly exposes them.
        "Access-Control-Expose-Headers": "x-csrf-token",
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


def parse_body(body):
    if body is None:
        return {}
    if isinstance(body, dict):
        return body
    if body.startswith("{"):
        return json.loads(body)
    return dict(parse_qsl(body))


def path_equals(event, method, path):
    event_path = get_event_path(event)
    event_method = event.get("httpMethod", event.get("requestContext", {}).get("http", {}).get("method"))
    return event_method == method and (event_path == path or event_path == path + "/" or path == "*")


def dynamo_obj_to_python_obj(dynamo_obj: dict) -> dict:
    deserializer = TypeDeserializer()
    return {k: deserializer.deserialize(v) for k, v in dynamo_obj.items()}


def decimal_to_number(value):
    # dynamo_obj_to_python_obj deserializes every DynamoDB Number as Decimal,
    # which json.dumps can't encode — convert back to a plain int/float right
    # before a value is going out over the wire.
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def python_obj_to_dynamo_obj(python_obj: dict) -> dict:
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in python_obj.items()}


def create_id(length):
    return "".join(secrets.choice(digits + lowercase_letters + uppercase_letters) for i in range(length))


# --- Admin login (phone OTP + cookie session) -------------------------------
# Ported near-verbatim from kaios-t9-wizard/backend/lambda/t9_wizard/utils.py
# — same OTP/session/CSRF mechanics, adapted for a single hardcoded admin
# rather than a general registered-user system: there's only ever one
# legitimate admin, so the identity check is a direct equality test instead
# of a DynamoDB user lookup, and no "user" records are ever written at all.
def get_admin_identity(phone):
    return phone if phone == ADMIN_PHONE else None


def get_cookies(event):
    # HTTP API (v2) puts cookies in a native top-level array; REST API (v1)
    # doesn't, and the Cookie header has to be split by hand instead. Handles
    # either shape rather than assuming one.
    if "cookies" in event:
        return event["cookies"]
    header = (event.get("headers") or {}).get("cookie") or (event.get("headers") or {}).get("Cookie")
    if not header:
        return []
    return [c.strip() for c in header.split(";")]


def find_cookie(cookies):
    for cookie in cookies:
        parts = cookie.split("=")
        cookie_name = parts[0].strip(" ;")
        if cookie_name == ADMIN_COOKIE_NAME:
            return parts[1].strip(" ;")
    return None


def create_otp(phone, otp_value):
    python_data = {
        "key1": "otp",
        "key2": phone,
        "otp": otp_value,
        "expiration": int(time.time()) + (5 * 60),
        "last_failure": 0,
    }
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def set_otp(phone, python_data):
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def get_otp(phone):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "otp", "key2": phone}),
        TableName=TABLE_NAME,
    )
    if "Item" not in result:
        return None
    return dynamo_obj_to_python_obj(result["Item"])


def delete_otp(phone):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "otp", "key2": phone}),
        TableName=TABLE_NAME,
    )


def create_token(phone):
    python_data = {
        "key1": "token",
        "key2": create_id(32),
        "csrf": create_id(32),
        "user": phone,
        "expiration": int(time.time()) + (4 * 30 * 24 * 60 * 60),
    }
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def get_token(token_string):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "token", "key2": token_string}),
        TableName=TABLE_NAME,
    )
    if "Item" not in result:
        return None
    return dynamo_obj_to_python_obj(result["Item"])


def delete_token(token_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "token", "key2": token_id}),
        TableName=TABLE_NAME,
    )


def get_active_tokens(phone):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "active_tokens", "key2": phone}),
        TableName=TABLE_NAME,
    )
    if "Item" in result:
        active_tokens = dynamo_obj_to_python_obj(result["Item"])
        active_tokens["tokens"] = {k: v for k, v in active_tokens["tokens"].items() if v > int(time.time())}
    else:
        active_tokens = {"key1": "active_tokens", "key2": phone, "tokens": {}}
    return active_tokens


def track_token(token_data):
    active_tokens = get_active_tokens(token_data["user"])
    active_tokens["tokens"][token_data["key2"]] = token_data["expiration"]
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(active_tokens))


# Wraps an admin-only route: validates the session cookie + CSRF token
# before calling through. The wrapped function receives (event, admin_phone,
# body) — admin_phone is always ADMIN_PHONE here (the only identity that can
# ever reach this point), passed through rather than hardcoded again so call
# sites don't need to import ADMIN_PHONE separately.
def authenticate(func):
    def wrapper_func(*args, **kwargs):
        event = args[0]
        cookie = find_cookie(get_cookies(event))
        body = parse_body(event.get("body"))
        csrf_token = body.get("csrf")
        token_data = get_token(cookie) if cookie else None
        if token_data is None or token_data["expiration"] < int(time.time()):
            return format_response(event=event, http_code=403, body="Your session has expired, please log in")
        active_tokens = get_active_tokens(token_data["user"])
        if token_data["key2"] not in active_tokens["tokens"]:
            return format_response(event=event, http_code=403, body="Your session has expired, please log in")
        if csrf_token is None or token_data["csrf"] != csrf_token:
            # token_data["key2"] is this session's own id — not key1, which
            # is just the literal record-type string "token" and would
            # delete the wrong (nonexistent) item.
            delete_token(token_data["key2"])
            return format_response(event=event, http_code=403, body="Your CSRF token is invalid, please log in again")
        return func(event, token_data["user"], body)

    return wrapper_func


def otp_route(event):
    body = parse_body(event.get("body"))
    phone = str(body.get("phone", ""))
    if not re.match(r"^\d{10}$", phone):
        return format_response(event=event, http_code=400, body="Invalid phone number, must be a 10 digit US number")

    if get_admin_identity(phone) is None:
        return format_response(event=event, http_code=401, body="You are not permitted to log in")

    otp_data = get_otp(phone)
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        otp_value = "".join(secrets.choice(digits) for _ in range(6))
        otp_data = create_otp(phone, otp_value)
        message = {
            "phone": f"+1{phone}",
            "message": f"{otp_data['otp']} is your Calorie Counter admin one-time passcode",
        }
        sqs.send_message(QueueUrl=SMS_SQS_QUEUE_URL, MessageBody=json.dumps(message))
        return format_response(event=event, http_code=200, body="OTP sent")
    return format_response(event=event, http_code=200, body="OTP already sent, please check your messages")


def login_route(event):
    body = parse_body(event.get("body"))
    phone = str(body.get("phone", ""))
    submitted_otp = body.get("otp")

    if get_admin_identity(phone) is None:
        return format_response(event=event, http_code=401, body="You are not permitted to log in")

    otp_data = get_otp(phone)
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        return format_response(event=event, http_code=400, body="OTP expired, please try again")
    diff = otp_data["last_failure"] + 30 - int(time.time())
    if diff > 0:
        return format_response(event=event, http_code=403, body=f"Please wait {diff} seconds before trying again")
    if submitted_otp != otp_data["otp"]:
        otp_data["last_failure"] = int(time.time())
        set_otp(phone, otp_data)
        return format_response(event=event, http_code=403, body="Incorrect OTP, please try again")

    delete_otp(phone)
    token_data = create_token(phone)
    track_token(token_data)
    date_string = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + (4 * 30 * 24 * 60 * 60)))
    return format_response(
        event=event,
        http_code=200,
        body="successfully logged in",
        headers={
            "x-csrf-token": token_data["csrf"],
            "Set-Cookie": f"{ADMIN_COOKIE_NAME}={token_data['key2']}; Domain={ADMIN_COOKIE_DOMAIN}; "
            f"Expires={date_string}; Secure; HttpOnly",
        },
    )


@authenticate
def logged_in_check_route(event, admin_phone, body):
    return format_response(event=event, http_code=200, body="You are logged in")
