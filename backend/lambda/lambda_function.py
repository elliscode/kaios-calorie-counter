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
from calorie_api.submit import submit_food_route, submit_upc_mapping_route
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
from calorie_api.search import search_route


def lambda_handler(event, context):
    try:
        log(get_request_metadata(event), event.get("headers"))
        result = route(event)
        return result
    except Exception:
        traceback.print_exc()
        return format_response(event=event, http_code=500, body="Internal server error")


# Only using POST because I want to prevent CORS preflight checks — see
# kaios-shared-list/backend/lambda/lambda_function.py for the fuller
# explanation of why that's the case here too.
def route(event):
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

    # End-user accounts (email OTP + cookie session) — a separate identity
    # system from the admin block above; entirely optional everywhere,
    # including /submit below — logging in just attaches a submission (and
    # gets you multi-device sync) rather than gating it.
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
    if path_equals(event=event, method="POST", path="/search"):
        return search_route(event)
    if path_equals(event=event, method="POST", path="/submit"):
        return submit_food_route(event)
    if path_equals(event=event, method="POST", path="/submit-upc-mapping"):
        return submit_upc_mapping_route(event)
    return format_response(event=event, http_code=403, body={"message": "Forbidden"})
