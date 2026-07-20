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
from calorie_api.admin import get_pending_route, review_route, export_route


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
    if path_equals(event=event, method="POST", path="/admin/presigned-get"):
        return presigned_get_route(event)

    if path_equals(event=event, method="POST", path="/test"):
        return format_response(event=event, http_code=200, body={"status": "up"})
    if path_equals(event=event, method="POST", path="/submit"):
        return submit_food_route(event)
    if path_equals(event=event, method="POST", path="/presigned-post"):
        return presigned_post_route(event)
    return format_response(event=event, http_code=403, body={"message": "Forbidden"})
