# KaiOS Calorie Counter Backend

There's two files that were used to initially seed the food database:

- from here https://fdc.nal.usda.gov/download-datasets
    - FNDDS 2021-2023 (JSON)
    - Branded December 2025 (JSON)
- look at the field names described in here https://fdc.nal.usda.gov/docs/Download_Field_Descriptions_Oct2020.pdf

## Prepare the data for the database

```
uv sync
```

## Lambda API

`lambda/` is a single Lambda function (no framework, plain Python — see `calorie_api/`) behind an API Gateway, structured the same way as `kaios-shared-list/backend`. Every route is `POST` only (to avoid CORS preflight — see the comment in `lambda_function.py`):

| Route | Purpose |
|-------|---------|
| `/test` | Health check — returns `{"status": "up"}` |
| `/submit` | Accepts a new food submission from the app's "+ Add New Food" form as plain JSON (`id`, `name`, `servingQuantity`, `servingName`, `calories`, `fat`, `carbohydrates`, `protein`, optional `photoKey`), stores it in DynamoDB with `status: "pending"` and a 30-day TTL for manual review |
| `/presigned-post` | Public — hands out a presigned S3 POST URL/fields so the app can upload a nutrition-facts photo **directly to S3**, bypassing this Lambda entirely. The object key is always `{id}.{extension}` (the food's own GUID), not a separately-generated name, so a submission's DynamoDB record and its photo always address by the same id. |
| `/admin/otp` | Admin login step 1 — texts a one-time code to `ADMIN_PHONE` via the shared SQS-triggered Twilio Lambda |
| `/admin/login` | Admin login step 2 — verifies the code, sets the session cookie + returns a CSRF token |
| `/admin/logged-in-check` | Confirms the current session/cookie is still valid |
| `/admin/pending` | Lists submitted foods still awaiting a decision (`approved` not yet set) |
| `/admin/review` | Accepts or rejects a submission — `id` + `approved` required, every other field optional (only present ones get corrected) |
| `/admin/export` | Returns every approved-but-not-yet-exported submission as a JSON array in the exact shape of `s3/2026-07-18-base-foods.json`, then marks them `exported: true` so a repeat call returns nothing new |
| `/admin/presigned-get` | Admin-only — presigned S3 GET (view + download) URLs for a submission's photo, since the photos bucket is private |

`admin.html` (`s3/admin.html`) is the actual review UI — a phone-OTP-gated page for approving/rejecting/correcting submissions and triggering exports, ported from `kaios-t9-wizard`'s admin login pattern.

### Environment variables

| Variable | Example | Description |
|----------|---------|--------------|
| `DOMAIN_NAMES` | `https://calories.elliscode.com,http://calorie-counter.localhost` | Comma-separated allowlist of `Origin` headers — the web app's domain and the packaged KaiOS app's origin. Any request from an origin not in this list gets a 403. |
| `DYNAMODB_TABLE_NAME` | `kaios-calorie-counter` | The DynamoDB table every route reads/writes. |
| `PHOTOS_BUCKET_NAME` | `daniel-townsend-kaios-calorie-counter-userspace` | The private S3 bucket nutrition-facts photos live in — accessed only via presigned URLs (see `PRESIGNED_AWS_ACCESS_KEY_ID` below), never directly by this Lambda. |
| `PRESIGNED_AWS_ACCESS_KEY_ID` / `PRESIGNED_AWS_SECRET_ACCESS_KEY` | — | Static credentials for a **dedicated** IAM identity used only to sign presigned S3 POST/GET URLs — deliberately not this Lambda's own execution role, so a presigned URL's permissions are scoped to exactly what that identity can do. Shared across the user's other projects; this project's bucket is just added to its existing permissions. |
| `ADMIN_PHONE` | — | The one legitimate admin's phone number (10 digits, no country code) — `/admin/otp`/`/admin/login` reject anyone else. |
| `SMS_SQS_QUEUE_URL` | — | The existing, project-agnostic SQS queue that an already-deployed Twilio Lambda consumes to actually send the OTP text — same queue `kaios-t9-wizard` uses, no new queue needed. |

Set these on the Lambda function itself (Configuration → Environment variables in the console, or `--environment` on `aws lambda create-function`/`update-function-configuration`).

### One-time AWS setup

1. Create a DynamoDB table named `kaios-calorie-counter` — partition key `key1` (String), sort key `key2` (String). Enable **TTL** on it with `expiration` as the attribute name (used by `otp`/`token` records and by `/submit`'s 30-day-pending-review records).
2. Confirm the private S3 bucket for submitted nutrition-facts photos exists (currently `daniel-townsend-kaios-calorie-counter-userspace`) — do **not** reuse the public static-app bucket. Add this bucket to the existing dedicated presigned-URL IAM identity's permissions (the one already used for other projects) rather than creating a new role.
3. Create a Lambda function (e.g. `calorie-counter-api-dev`), Python 3.14 runtime, with the environment variables listed above. Grant its own IAM role `dynamodb:PutItem`/`GetItem`/`UpdateItem`/`Query`/`DeleteItem` on the table and `sqs:SendMessage` on the SMS queue — it needs **no S3 permissions at all**, since every photo operation goes through the separate dedicated presigned credentials instead.
4. Set up an API Gateway with an ANY method + proxy integration targeting this Lambda.
5. Run `sh dev-release.sh` (or `prod-release.sh`) to deploy.

**Not a setup step, just worth knowing**: an S3 Lifecycle rule expiring objects in the photos bucket after 30 days (matching the DynamoDB TTL above) keeps an expired submission's photo from lingering indefinitely as orphaned storage once its DynamoDB record is gone.

### Releasing

```
sh dev-release.sh
sh prod-release.sh
```
