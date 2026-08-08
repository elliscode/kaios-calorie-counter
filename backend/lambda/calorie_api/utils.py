import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qsl

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

from .logger import log

DOMAIN_NAMES = os.environ.get("DOMAIN_NAMES", "").split(",")
TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME")
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

# End-user accounts (see find_or_create_user_id / authenticate_user below) —
# email+OTP login, a separate identity system from the single hardcoded
# admin above. Same cookie domain wildcard, distinct cookie name so the two
# sessions never collide.
USER_COOKIE_NAME = "calorie-counter-user-token"
USER_COOKIE_DOMAIN = ADMIN_COOKIE_DOMAIN
SES_REGION = os.environ.get("SES_REGION", "us-east-1")
SES_SENDER_EMAIL = os.environ.get("SES_SENDER_EMAIL")
SES_REPLY_TO_EMAIL = os.environ.get("SES_REPLY_TO_EMAIL")
SES_TEMPLATE_NAME = os.environ.get("SES_TEMPLATE_NAME")
# Does double duty, matching kaios-shared-list's convention: the HMAC key
# for hash_email below, and the symmetric key for encrypt_field/decrypt_field
# on every synced user_foods/user_diary/user_preferences record.
ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY")

digits = "0123456789"
lowercase_letters = "abcdefghijklmnopqrstuvwxyz"
uppercase_letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# Shared by submit.py, presigned.py, and admin.py — a food's id is always a
# client-generated GUID (see frontend-v3/app.js's generateGuid()).
GUID_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

dynamo = boto3.client("dynamodb")
sqs = boto3.client("sqs")
ses = boto3.client("ses", region_name=SES_REGION)


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
    # before a value is going out over the wire. Recurses into lists/dicts
    # too (e.g. a food submission's "servings" list of maps), not just bare
    # top-level values.
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [decimal_to_number(v) for v in value]
    if isinstance(value, dict):
        return {k: decimal_to_number(v) for k, v in value.items()}
    return value


def python_obj_to_dynamo_obj(python_obj: dict) -> dict:
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in python_obj.items()}


def parse_decimal(value):
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


# Shared by submit.py (new submissions) and admin.py's review_route (admin
# corrections) — a "serving" is always this same shape everywhere in the
# app, from the local IndexedDB food records through to what gets exported.
def parse_serving(raw):
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    quantity = parse_decimal(raw.get("quantity"))
    calories = parse_decimal(raw.get("calories"))
    fat = parse_decimal(raw.get("fat")) or Decimal(0)
    carbohydrates = parse_decimal(raw.get("carbohydrates")) or Decimal(0)
    protein = parse_decimal(raw.get("protein")) or Decimal(0)
    # Only ever set by an admin during review, not by the submitting user —
    # the "+ Add New Food" form has no caffeine/alcohol fields at all,
    # deliberately (not worth trusting arbitrary user input for these), so
    # both are always 0 on a fresh submission until an admin fills them in.
    caffeine = parse_decimal(raw.get("caffeine")) or Decimal(0)
    alcohol = parse_decimal(raw.get("alcohol")) or Decimal(0)
    if not name or quantity is None or quantity <= 0 or calories is None:
        return None
    return {
        "name": name,
        "quantity": quantity,
        "calories": calories,
        "fat": fat,
        "carbohydrates": carbohydrates,
        "protein": protein,
        "caffeine": caffeine,
        "alcohol": alcohol,
    }


def parse_servings(raw_list):
    if not isinstance(raw_list, list) or not raw_list:
        return None
    parsed = [parse_serving(item) for item in raw_list]
    if any(p is None for p in parsed):
        return None
    return parsed


def create_id(length):
    return "".join(secrets.choice(digits + lowercase_letters + uppercase_letters) for i in range(length))


# --- Field-level encryption for synced user data ----------------------------
# Ported from kaios-shared-list/backend/lambda/shared_list/utils.py — a
# lightweight, stdlib-only cipher (SHA256-counter-mode keystream XOR, random
# 16-byte nonce per record). This is deliberately not a hardened scheme —
# anyone with ENCRYPTION_KEY and this code can trivially decrypt, same as the
# source project. The goal is keeping a user's own diary/foods/settings out
# of casual view in the DynamoDB console, not withstanding a determined
# attacker with Lambda access.
def _keystream(key_bytes, nonce, length):
    stream = b""
    counter = 0
    while len(stream) < length:
        stream += hashlib.sha256(key_bytes + nonce + counter.to_bytes(4, "big")).digest()
        counter += 1
    return stream[:length]


def encrypt_field(value):
    key_bytes = bytes.fromhex(ENCRYPTION_KEY)
    payload = (value if isinstance(value, str) else json.dumps(value)).encode()
    nonce = secrets.token_bytes(16)
    ciphertext = bytes(a ^ b for a, b in zip(payload, _keystream(key_bytes, nonce, len(payload))))
    return base64.b64encode(nonce + ciphertext).decode()


def decrypt_field(encrypted, as_json=False):
    key_bytes = bytes.fromhex(ENCRYPTION_KEY)
    data = base64.b64decode(encrypted)
    nonce, ciphertext = data[:16], data[16:]
    plaintext = bytes(a ^ b for a, b in zip(ciphertext, _keystream(key_bytes, nonce, len(ciphertext)))).decode()
    return json.loads(plaintext) if as_json else plaintext


def hash_email(email):
    return hmac.new(ENCRYPTION_KEY.encode(), email.strip().lower().encode(), hashlib.sha256).hexdigest()


# Shared by submit.py (dual-write on submission) and sync.py (every sync
# route) — a user's foods/diary-per-date/preferences are each stored as one
# DynamoDB item holding a single opaque "data" attribute (see encrypt_field
# above), not a native map, so nothing readable ever sits in the table.
def load_encrypted_collection(key1, key2):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": key1, "key2": key2}),
        TableName=TABLE_NAME,
    )
    if "Item" not in result:
        return {}
    return decrypt_field(dynamo_obj_to_python_obj(result["Item"])["data"], as_json=True)


def store_encrypted_collection(key1, key2, data):
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj({"key1": key1, "key2": key2, "data": encrypt_field(data)}),
    )


# A UPC identifies a *product*, not a food — many products (different sizes,
# formats, regional packaging) legitimately share the same food, differing
# only in which serving they represent. This is the join record for that:
# (upc) -> (foodId, servingName, servingQuantity), kept entirely separate
# from both the food itself and the remote UPC->product lookup table.
# servingQuantity disambiguates exactly which serving row is meant (serving
# name alone happens to be unique within a food in the current shipped
# catalog, but this record shouldn't depend on that holding forever) — kept
# as a plain string like serving_name, since nothing ever queries by it.
# Created as a side effect of submit.py's submit_food_route and admin.py's
# add_food_route whenever a upc is present, always pointing at the
# submission's first serving — see calorie_api/admin.py for the
# pending/review/export routes that manage these once created.
UPC_MAPPING_TTL_SECONDS = 30 * 24 * 60 * 60  # same as submitted_food's own TTL


def create_upc_mapping(upc, food_id, food_name, serving_name, serving_quantity):
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj(
            {
                "key1": "upc_mapping",
                "key2": upc,
                "upc": upc,
                "foodId": food_id,
                "foodName": food_name,  # denormalized for admin display — not part of the final export
                "servingName": serving_name,
                "servingQuantity": serving_quantity,
                "submittedAt": int(time.time()),
                "expiration": int(time.time()) + UPC_MAPPING_TTL_SECONDS,
            }
        ),
    )


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
            # Path=/ explicitly, not left to the browser's default (which
            # would scope it to "/admin", the directory /admin/login itself
            # lives under) — harmless today since every admin route already
            # lives under /admin/*, but the same missing-Path bug bit the
            # user-account cookie in account.py once a route outside its own
            # login path needed it, so it's fixed here too before it can.
            "Set-Cookie": f"{ADMIN_COOKIE_NAME}={token_data['key2']}; Domain={ADMIN_COOKIE_DOMAIN}; Path=/; "
            f"Expires={date_string}; Secure; HttpOnly",
        },
    )


@authenticate
def logged_in_check_route(event, admin_phone, body):
    return format_response(event=event, http_code=200, body="You are logged in")


# --- End-user account login (email OTP + cookie session) --------------------
# Same OTP/session/CSRF mechanics as the admin login above, but under a
# separate key1 namespace ("user_*") and for any registered email, not one
# hardcoded admin. Deliberately duplicated rather than generalizing the admin
# functions above with extra parameters — this is a live, load-bearing login
# already used by s3/admin.html, and duplicating a few dozen lines is a much
# smaller risk than reworking it.
# Named so account.py can quote the same number in the OTP email rather than
# a second hardcoded "5" drifting out of sync with the real expiration below.
USER_OTP_TIMEOUT_MINUTES = 5


def find_or_create_user_id(email):
    email_hash = hash_email(email)
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_email", "key2": email_hash}),
        TableName=TABLE_NAME,
    )
    if "Item" in result:
        return dynamo_obj_to_python_obj(result["Item"])["user_id"]
    user_id = create_id(20)
    dynamo.put_item(
        TableName=TABLE_NAME,
        Item=python_obj_to_dynamo_obj({"key1": "user_email", "key2": email_hash, "user_id": user_id}),
    )
    return user_id


def create_user_otp(user_id, otp_value):
    python_data = {
        "key1": "user_otp",
        "key2": user_id,
        "otp": otp_value,
        "expiration": int(time.time()) + (USER_OTP_TIMEOUT_MINUTES * 60),
        "last_failure": 0,
    }
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def set_user_otp(user_id, python_data):
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def get_user_otp(user_id):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_otp", "key2": user_id}),
        TableName=TABLE_NAME,
    )
    if "Item" not in result:
        return None
    return dynamo_obj_to_python_obj(result["Item"])


def delete_user_otp(user_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_otp", "key2": user_id}),
        TableName=TABLE_NAME,
    )


def create_user_token(user_id):
    python_data = {
        "key1": "user_token",
        "key2": create_id(32),
        "csrf": create_id(32),
        "user_id": user_id,
        "expiration": int(time.time()) + (4 * 30 * 24 * 60 * 60),
    }
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(python_data))
    return python_data


def get_user_token(token_string):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_token", "key2": token_string}),
        TableName=TABLE_NAME,
    )
    if "Item" not in result:
        return None
    return dynamo_obj_to_python_obj(result["Item"])


def delete_user_token(token_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_token", "key2": token_id}),
        TableName=TABLE_NAME,
    )


def get_user_active_tokens(user_id):
    result = dynamo.get_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_active_tokens", "key2": user_id}),
        TableName=TABLE_NAME,
    )
    if "Item" in result:
        active_tokens = dynamo_obj_to_python_obj(result["Item"])
        active_tokens["tokens"] = {k: v for k, v in active_tokens["tokens"].items() if v > int(time.time())}
    else:
        active_tokens = {"key1": "user_active_tokens", "key2": user_id, "tokens": {}}
    return active_tokens


def track_user_token(token_data):
    active_tokens = get_user_active_tokens(token_data["user_id"])
    active_tokens["tokens"][token_data["key2"]] = token_data["expiration"]
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(active_tokens))


# Actually extends the token's expiration (not just re-sending the old
# date in a fresh Set-Cookie header) — expiration doubles as this table's
# DynamoDB TTL attribute, so a refresh that only changed the cookie without
# touching the stored item would let DynamoDB silently delete the token
# before the browser's own copy of the cookie says it should expire.
def refresh_user_token(token_data):
    token_data["expiration"] = int(time.time()) + (4 * 30 * 24 * 60 * 60)
    dynamo.put_item(TableName=TABLE_NAME, Item=python_obj_to_dynamo_obj(token_data))
    track_user_token(token_data)
    return token_data


def delete_user_active_tokens(user_id):
    dynamo.delete_item(
        Key=python_obj_to_dynamo_obj({"key1": "user_active_tokens", "key2": user_id}),
        TableName=TABLE_NAME,
    )


def find_user_cookie(cookies):
    for cookie in cookies:
        parts = cookie.split("=")
        cookie_name = parts[0].strip(" ;")
        if cookie_name == USER_COOKIE_NAME:
            return parts[1].strip(" ;")
    return None


# Wraps a login-required route: validates the session cookie + CSRF token
# before calling through, same shape as `authenticate` above but for any
# registered user rather than the one hardcoded admin. The wrapped function
# receives (event, user_id, body).
def authenticate_user(func):
    def wrapper_func(*args, **kwargs):
        event = args[0]
        cookie = find_user_cookie(get_cookies(event))
        body = parse_body(event.get("body"))
        csrf_token = body.get("csrf")
        token_data = get_user_token(cookie) if cookie else None
        if token_data is None or token_data["expiration"] < int(time.time()):
            return format_response(event=event, http_code=403, body="Your session has expired, please log in")
        active_tokens = get_user_active_tokens(token_data["user_id"])
        if token_data["key2"] not in active_tokens["tokens"]:
            return format_response(event=event, http_code=403, body="Your session has expired, please log in")
        if csrf_token is None or token_data["csrf"] != csrf_token:
            # token_data["key2"] is this session's own id — not key1, which
            # is just the literal record-type string "user_token" and would
            # delete the wrong (nonexistent) item.
            delete_user_token(token_data["key2"])
            return format_response(event=event, http_code=403, body="Your CSRF token is invalid, please log in again")
        return func(event, token_data["user_id"], body)

    return wrapper_func


# Same session/CSRF validation as authenticate_user, but a missing or invalid
# session just means user_id=None rather than a 403 — for routes that work
# fine anonymously (see submit_food_route) but still attach the submission
# to an account when a valid one is present, e.g. to dual-write into that
# user's own synced foods. Never deletes/invalidates a token on a bad CSRF
# here (unlike authenticate_user) — a route that tolerates no session at all
# shouldn't punish a merely-stale one either, since there's nothing gated
# behind it to protect.
def optionally_authenticate_user(func):
    def wrapper_func(*args, **kwargs):
        event = args[0]
        cookie = find_user_cookie(get_cookies(event))
        body = parse_body(event.get("body"))
        csrf_token = body.get("csrf")
        token_data = get_user_token(cookie) if cookie else None
        user_id = None
        if token_data and token_data["expiration"] >= int(time.time()):
            active_tokens = get_user_active_tokens(token_data["user_id"])
            if token_data["key2"] in active_tokens["tokens"] and csrf_token == token_data["csrf"]:
                user_id = token_data["user_id"]
        return func(event, user_id, body)

    return wrapper_func
