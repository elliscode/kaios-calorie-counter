import json
import traceback

from calorie_api.logger import log
from calorie_api.utils import (
    path_equals,
    format_response,
    has_invalid_domain,
    get_request_metadata,
    otp_route,
    login_route,
    logged_in_check_route,
)
from calorie_api.submit import submit_food_route
from calorie_api.presigned import presigned_post_route, presigned_get_route
from calorie_api.admin import (
    get_pending_route,
    review_route,
    export_route,
    add_food_route,
    add_upc_mapping_route,
    review_upc_mapping_route,
    export_upc_mappings_route,
)
from calorie_api.account import (
    account_otp_route,
    account_login_route,
    account_logged_in_check_route,
    account_log_out_all_route,
    account_refresh_route,
)
from calorie_api.sync import sync_foods_route, sync_diary_route, sync_preferences_route
from calorie_api.upc import lookup_upc_route


def lambda_handler(event, context):
    try:
        log(get_request_metadata(event), event.get("headers"))
        result = route(event)
        return result
    except Exception:
        traceback.print_exc()
        return format_response(event=event, http_code=500, body="Internal server error")


# Temporary diagnostic route: echoes back whatever headers this request
# actually arrived with, so a real device can see for itself (via the Options
# panel) whether its GET requests include an Origin header at all — bypasses
# the normal domain/CORS gate entirely (both has_invalid_domain below and
# format_response's own origin check) since the whole point is to work and
# show something even when Origin is missing or doesn't match DOMAIN_NAMES.
# Remove once the Gecko-omits-Origin-on-GET question is answered.
def debug_headers_route(event):
    headers = event.get("headers") or {}
    log("debug-headers", headers)
    return {
        "statusCode": 200,
        "body": json.dumps({"headers": headers}),
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
        },
    }


# Only using POST because I want to prevent CORS preflight checks — see
# kaios-shared-list/backend/lambda/lambda_function.py for the fuller
# explanation of why that's the case here too.
def route(event):
    if path_equals(event=event, method="GET", path="/debug-headers"):
        return debug_headers_route(event)

    if has_invalid_domain(event=event):
        return format_response(event=event, http_code=403, body={"message": "Forbidden"})

    # Admin moderation routes — unscoped, checked alongside everything else
    # (there's no versioning scheme in this API at all, unlike kaios-t9-wizard).
    if path_equals(event=event, method="POST", path="/admin/otp"):
        return otp_route(event)
    if path_equals(event=event, method="POST", path="/admin/login"):
        return login_route(event)
    if path_equals(event=event, method="POST", path="/admin/logged-in-check"):
        return logged_in_check_route(event)
    if path_equals(event=event, method="POST", path="/admin/pending"):
        return get_pending_route(event)
    if path_equals(event=event, method="POST", path="/admin/review"):
        return review_route(event)
    if path_equals(event=event, method="POST", path="/admin/export"):
        return export_route(event)
    if path_equals(event=event, method="POST", path="/admin/add-food"):
        return add_food_route(event)
    if path_equals(event=event, method="POST", path="/admin/add-upc-mapping"):
        return add_upc_mapping_route(event)
    if path_equals(event=event, method="POST", path="/admin/review-upc-mapping"):
        return review_upc_mapping_route(event)
    if path_equals(event=event, method="POST", path="/admin/export-upc-mappings"):
        return export_upc_mappings_route(event)
    if path_equals(event=event, method="POST", path="/admin/presigned-get"):
        return presigned_get_route(event)

    # End-user accounts (email OTP + cookie session) — a separate identity
    # system from the admin block above; login is optional for everything
    # except /submit and /presigned-post below.
    if path_equals(event=event, method="POST", path="/account/otp"):
        return account_otp_route(event)
    if path_equals(event=event, method="POST", path="/account/login"):
        return account_login_route(event)
    if path_equals(event=event, method="POST", path="/account/logged-in-check"):
        return account_logged_in_check_route(event)
    if path_equals(event=event, method="POST", path="/account/log-out-all"):
        return account_log_out_all_route(event)
    if path_equals(event=event, method="POST", path="/account/refresh"):
        return account_refresh_route(event)

    # Multi-device sync — each route merges the client's payload against
    # what's already stored (newer "updated" timestamp wins) and returns the
    # merged result; login-required, same session as the /account/* routes.
    if path_equals(event=event, method="POST", path="/sync/foods"):
        return sync_foods_route(event)
    if path_equals(event=event, method="POST", path="/sync/diary"):
        return sync_diary_route(event)
    if path_equals(event=event, method="POST", path="/sync/preferences"):
        return sync_preferences_route(event)

    if path_equals(event=event, method="POST", path="/test"):
        return format_response(event=event, http_code=200, body={"status": "up"})
    if path_equals(event=event, method="POST", path="/lookup-upc"):
        return lookup_upc_route(event)
    if path_equals(event=event, method="POST", path="/submit"):
        return submit_food_route(event)
    if path_equals(event=event, method="POST", path="/presigned-post"):
        return presigned_post_route(event)
    return format_response(event=event, http_code=403, body={"message": "Forbidden"})
