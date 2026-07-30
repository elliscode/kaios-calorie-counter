import json
import re
import secrets
import time

from .utils import (
    format_response,
    parse_body,
    authenticate_user,
    find_or_create_user_id,
    create_user_otp,
    set_user_otp,
    get_user_otp,
    delete_user_otp,
    create_user_token,
    track_user_token,
    refresh_user_token,
    get_user_token,
    find_user_cookie,
    get_cookies,
    delete_user_active_tokens,
    USER_COOKIE_NAME,
    USER_COOKIE_DOMAIN,
    USER_OTP_TIMEOUT_MINUTES,
    SES_SENDER_EMAIL,
    SES_REPLY_TO_EMAIL,
    SES_TEMPLATE_NAME,
    ses,
    digits,
)

EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _set_cookie_header(token_id, expiration):
    date_string = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(expiration))
    # Path=/ is required here, not optional — without it, the browser
    # defaults Path to the *directory* of whatever endpoint set the cookie
    # (i.e. "/account", since that's where /account/login lives), so the
    # cookie would only ever be sent back on other /account/* calls and
    # never on /submit, /presigned-post, or /sync/* — which is exactly the
    # bug that was happening before this line existed.
    return (
        f"{USER_COOKIE_NAME}={token_id}; Domain={USER_COOKIE_DOMAIN}; Path=/; "
        f"Expires={date_string}; Secure; HttpOnly"
    )


def send_otp_email(email, otp):
    ses.send_templated_email(
        Source=SES_SENDER_EMAIL,
        Destination={"ToAddresses": [email]},
        ReplyToAddresses=[SES_REPLY_TO_EMAIL],
        Template=SES_TEMPLATE_NAME,
        TemplateData=json.dumps({"otp": otp, "minutes": USER_OTP_TIMEOUT_MINUTES}),
    )


def account_otp_route(event):
    body = parse_body(event.get("body"))
    email = str(body.get("email", "")).strip().lower()
    if not EMAIL_REGEX.match(email):
        return format_response(event=event, http_code=400, body="A valid email address is required")

    user_id = find_or_create_user_id(email)
    otp_data = get_user_otp(user_id)
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        otp_value = "".join(secrets.choice(digits) for _ in range(6))
        otp_data = create_user_otp(user_id, otp_value)
        send_otp_email(email, otp_data["otp"])
        return format_response(event=event, http_code=200, body="OTP sent")
    return format_response(event=event, http_code=200, body="OTP already sent, please check your email")


def account_login_route(event):
    body = parse_body(event.get("body"))
    email = str(body.get("email", "")).strip().lower()
    submitted_otp = body.get("otp")

    if not EMAIL_REGEX.match(email):
        return format_response(event=event, http_code=400, body="A valid email address is required")

    user_id = find_or_create_user_id(email)
    otp_data = get_user_otp(user_id)
    if otp_data is None or otp_data["expiration"] < int(time.time()):
        return format_response(event=event, http_code=400, body="OTP expired, please try again")
    diff = otp_data["last_failure"] + 30 - int(time.time())
    if diff > 0:
        return format_response(event=event, http_code=403, body=f"Please wait {diff} seconds before trying again")
    if submitted_otp != otp_data["otp"]:
        otp_data["last_failure"] = int(time.time())
        set_user_otp(user_id, otp_data)
        return format_response(event=event, http_code=403, body="Incorrect OTP, please try again")

    delete_user_otp(user_id)
    token_data = create_user_token(user_id)
    track_user_token(token_data)
    return format_response(
        event=event,
        http_code=200,
        body="successfully logged in",
        headers={
            "x-csrf-token": token_data["csrf"],
            "Set-Cookie": _set_cookie_header(token_data["key2"], token_data["expiration"]),
        },
    )


@authenticate_user
def account_logged_in_check_route(event, user_id, body):
    return format_response(event=event, http_code=200, body="You are logged in")


@authenticate_user
def account_log_out_all_route(event, user_id, body):
    delete_user_active_tokens(user_id)
    return format_response(event=event, http_code=200, body="Logged out everywhere")


# Extends the session's lifetime and re-issues the cookie with the new,
# later Expires date — meant to be called periodically by a client that's
# still actively in use, so a long-lived install doesn't get logged out
# after 4 months of otherwise-continuous use.
@authenticate_user
def account_refresh_route(event, user_id, body):
    cookie = find_user_cookie(get_cookies(event))
    token_data = get_user_token(cookie)
    token_data = refresh_user_token(token_data)
    return format_response(
        event=event,
        http_code=200,
        body="successfully refreshed session",
        headers={"Set-Cookie": _set_cookie_header(token_data["key2"], token_data["expiration"])},
    )
