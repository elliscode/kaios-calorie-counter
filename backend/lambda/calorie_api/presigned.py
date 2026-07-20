import re

from .logger import log
from .utils import format_response, parse_body, authenticate, get_presigned_s3_client, GUID_REGEX, PHOTOS_BUCKET_NAME

PHOTO_KEY_REGEX = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|gif|webp)$", re.IGNORECASE
)

# Nutrition-facts label photos only — narrower than other "dumbphone apps"
# projects' presigned-post (which also allow video extensions for a
# different kind of upload). Values are the Content-Type S3 will require the
# browser's upload to declare.
CONTENT_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}

MAX_UPLOAD_BYTES = 10_000_000  # 10MB — this endpoint is public/anonymous (unlike the reference it's based
# on, which sits behind that app's own login), so a size cap is a reasonable guard against abuse.


def presigned_post_route(event):
    body = parse_body(event.get("body"))
    food_id = (body.get("id") or "").strip()
    extension = (body.get("extension") or "").strip().lower()

    if not GUID_REGEX.match(food_id):
        return format_response(event=event, http_code=400, body="A valid id is required")
    if extension not in CONTENT_TYPES:
        return format_response(event=event, http_code=400, body=f"Invalid extension supplied {extension}")

    s3 = get_presigned_s3_client()
    try:
        # The S3 key is the food's own id — not a separately-generated
        # random name — so the photo and its DynamoDB record always address
        # by the same GUID.
        response = s3.generate_presigned_post(
            Bucket=PHOTOS_BUCKET_NAME,
            Key=f"{food_id}.{extension}",
            ExpiresIn=600,
            Fields={"Content-Type": CONTENT_TYPES[extension]},
            Conditions=[
                ["starts-with", "$Content-Type", ""],
                ["content-length-range", 0, MAX_UPLOAD_BYTES],
            ],
        )
        log("Got presigned POST URL", food_id)
        return format_response(event=event, http_code=200, body=response)
    except Exception as e:
        log(e, "Couldn't get a presigned POST URL", food_id)
    return format_response(event=event, http_code=500, body="Could not create a presigned url")


@authenticate
def presigned_get_route(event, admin_phone, body):
    # This takes the *full* S3 object key (the submitted_food record's own
    # photoKey, e.g. "<guid>.jpg") — not the bare id — since the extension is
    # part of the real key and isn't otherwise recoverable here.
    photo_key = (body.get("photoKey") or "").strip()
    if not PHOTO_KEY_REGEX.match(photo_key):
        return format_response(event=event, http_code=400, body="A valid photoKey is required")

    s3 = get_presigned_s3_client()
    try:
        view_url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": PHOTOS_BUCKET_NAME, "Key": photo_key},
            ExpiresIn=600,
        )
        download_url = s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": PHOTOS_BUCKET_NAME,
                "Key": photo_key,
                "ResponseContentDisposition": "attachment",
            },
            ExpiresIn=600,
        )
        return format_response(event=event, http_code=200, body={"url": view_url, "download_url": download_url})
    except Exception as e:
        log(e, "Couldn't get a presigned GET URL", photo_key)
    return format_response(event=event, http_code=500, body="Could not create a presigned url")
