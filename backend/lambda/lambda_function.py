import traceback

from calorie_api.logger import log
from calorie_api.utils import path_equals, format_response, has_invalid_domain, get_request_metadata
from calorie_api.submit import submit_food_route


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
    if path_equals(event=event, method="POST", path="/test"):
        return format_response(event=event, http_code=200, body={"status": "up"})
    if path_equals(event=event, method="POST", path="/submit"):
        return submit_food_route(event)
    return format_response(event=event, http_code=403, body={"message": "Forbidden"})
