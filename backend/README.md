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
| `/submit` | **Login required** (see `/account/*` below). Accepts a new food submission from the app's "+ Add New Food" form as plain JSON (`id`, `name`, `servings` — a non-empty array of `{name, quantity, calories, fat, carbohydrates, protein}`, one per serving the user defined — optional `photoKey`), stores it in DynamoDB with `status: "pending"` and a 30-day TTL for manual review. The same food is also upserted into the submitter's own synced foods collection (`user_foods`) in the same call — one action, two effects. |
| `/presigned-post` | **Login required.** Hands out a presigned S3 POST URL/fields so the app can upload a nutrition-facts photo **directly to S3**, bypassing this Lambda entirely. The object key is always `{id}.{extension}` (the food's own GUID), not a separately-generated name, so a submission's DynamoDB record and its photo always address by the same id. |
| `/admin/otp` | Admin login step 1 — texts a one-time code to `ADMIN_PHONE` via the shared SQS-triggered Twilio Lambda |
| `/admin/login` | Admin login step 2 — verifies the code, sets the session cookie + returns a CSRF token |
| `/admin/logged-in-check` | Confirms the current session/cookie is still valid |
| `/admin/pending` | Lists submitted foods still awaiting a decision (`approved` not yet set) |
| `/admin/review` | Accepts or rejects a submission — `id` + `approved` required; `name` and `servings` (the whole array, replacing it) are both optional corrections, only applied if present. Submissions from before this shape existed (flat `servingQuantity`/`servingName`/etc. fields) are read back with a `servings` array synthesized on the fly, so old and new submissions look the same to the admin page. |
| `/admin/export` | Returns every approved-but-not-yet-exported submission as a JSON array in the exact shape of `s3/2026-07-18-base-foods.json`, then marks them `exported: true` so a repeat call returns nothing new |
| `/admin/presigned-get` | Admin-only — presigned S3 GET (view + download) URLs for a submission's photo, since the photos bucket is private |
| `/account/otp` | End-user login step 1 — emails a one-time code to whatever address the client supplies, via SES. An account is implicitly created on first use — there's no separate signup |
| `/account/login` | End-user login step 2 — verifies the code, sets the session cookie + returns a CSRF token |
| `/account/logged-in-check` | Confirms the current end-user session/cookie is still valid |
| `/account/log-out-all` | Invalidates every active session for the logged-in user (sign out everywhere, not just this device) |
| `/account/refresh` | Extends the current session's expiration (another 4 months) and re-issues the cookie with the new date — meant to be called periodically by a client still in active use, so a long-lived install never gets silently logged out |
| `/sync/foods` | **Login required.** Body `{csrf, foods: {foodId: {...}}}` — merges the client's custom-foods collection against what's stored for this account (newer `updated` timestamp wins per food, whole item as a unit) and returns the merged result |
| `/sync/diary` | **Login required.** Body `{csrf, date: "YYYY-MM-DD", entries: {entryId: {...}}}` — merges and returns exactly one calendar date's diary entries; never reads or writes any other date |
| `/sync/preferences` | **Login required.** Body `{csrf, settings?, lastServings?, usageCounts?}` — each key is optional and merged independently (the `showCaffeine` setting, last-used-serving-per-food, and per-food usage counts) |

`admin.html` (`s3/admin.html`) is the actual review UI — a phone-OTP-gated page for approving/rejecting/correcting submissions and triggering exports, ported from `kaios-t9-wizard`'s admin login pattern.

### End-user accounts and sync

Logging in is entirely optional for using the app — diary, browsing the catalog, everything works fully anonymously, exactly as before. The one exception is creating a custom food (`/submit`, and the `/presigned-post` upload that goes with it): both now require a logged-in session, as a deliberate spam gate on the moderation queue.

Every synced item (`user_foods`, `user_diary`, `user_preferences`) is stored **encrypted at rest** — a lightweight stdlib cipher (SHA256-counter-mode keystream, ported from `kaios-shared-list`), keyed by `ENCRYPTION_KEY` below — so a DynamoDB console browse never shows readable diary/food/settings content, only ciphertext. It's an obfuscation layer, not a hardened one: anyone with the code and the key can decrypt, same as the sibling project it's ported from.

Sync uses the same reconciliation approach as `kaios-shared-list`: each sync route loads the account's current stored collection, merges the client's payload item-by-item (whichever side has the newer `updated` timestamp wins, whole item as a unit), stores the merged result, and returns it — the client is expected to replace its local copy with the response. Deletions are tombstones (`deleted: true` with a fresh `updated`), purged from storage 120 days after their `updated` time.

### Environment variables

| Variable | Example | Description |
|----------|---------|--------------|
| `DOMAIN_NAMES` | `https://calories.elliscode.com,http://calorie-counter.localhost` | Comma-separated allowlist of `Origin` headers — the web app's domain and the packaged KaiOS app's origin. Any request from an origin not in this list gets a 403. |
| `DYNAMODB_TABLE_NAME` | `kaios-calorie-counter` | The DynamoDB table every route reads/writes. |
| `PHOTOS_BUCKET_NAME` | `daniel-townsend-kaios-calorie-counter-userspace` | The private S3 bucket nutrition-facts photos live in — accessed only via presigned URLs (see `PRESIGNED_AWS_ACCESS_KEY_ID` below), never directly by this Lambda. |
| `PRESIGNED_AWS_ACCESS_KEY_ID` / `PRESIGNED_AWS_SECRET_ACCESS_KEY` | — | Static credentials for a **dedicated** IAM identity used only to sign presigned S3 POST/GET URLs — deliberately not this Lambda's own execution role, so a presigned URL's permissions are scoped to exactly what that identity can do. Shared across the user's other projects; this project's bucket is just added to its existing permissions. |
| `ADMIN_PHONE` | — | The one legitimate admin's phone number (10 digits, no country code) — `/admin/otp`/`/admin/login` reject anyone else. |
| `SMS_SQS_QUEUE_URL` | — | The existing, project-agnostic SQS queue that an already-deployed Twilio Lambda consumes to actually send the OTP text — same queue `kaios-t9-wizard` uses, no new queue needed. |
| `SES_REGION` | `us-east-1` | AWS region for the SES client that sends end-user login OTP emails. |
| `SES_SENDER_EMAIL` | `login@calories.elliscode.com` | Verified SES "From" address for `/account/otp` emails. |
| `SES_REPLY_TO_EMAIL` | `daniel@elliscode.com` | Reply-To address on those emails. |
| `SES_TEMPLATE_NAME` | `calorie-counter-otp-template` | Name of the SES email template `/account/otp` sends with (`{{otp}}`/`{{minutes}}` are the variables it substitutes) — see the one-time setup step below for creating it. |
| `ENCRYPTION_KEY` | (hex secret, e.g. `openssl rand -hex 32`) | Does double duty: the HMAC key used to hash a user's email before using it as a DynamoDB lookup key (raw emails are never stored), **and** the symmetric key for encrypting/decrypting every synced `user_foods`/`user_diary`/`user_preferences` record. Losing this key makes all synced data permanently unreadable — back it up somewhere durable (a password manager entry), not just the Lambda console. |

Set these on the Lambda function itself (Configuration → Environment variables in the console, or `--environment` on `aws lambda create-function`/`update-function-configuration`).

### One-time AWS setup

1. Create a DynamoDB table named `kaios-calorie-counter` — partition key `key1` (String), sort key `key2` (String). Enable **TTL** on it with `expiration` as the attribute name (used by `otp`/`token` records and by `/submit`'s 30-day-pending-review records).
2. Confirm the private S3 bucket for submitted nutrition-facts photos exists (currently `daniel-townsend-kaios-calorie-counter-userspace`) — do **not** reuse the public static-app bucket. Add this bucket to the existing dedicated presigned-URL IAM identity's permissions (the one already used for other projects) rather than creating a new role. **Also set the bucket's own CORS configuration** (Permissions → Cross-origin resource sharing) — the photo upload goes straight from the browser to S3 via the presigned POST (bypassing the Lambda entirely), so without this the upload fails with a CORS error even though the presigned URL itself is valid:
   ```json
   [
     {
       "AllowedHeaders": ["*"],
       "AllowedMethods": ["POST"],
       "AllowedOrigins": ["https://calories.elliscode.com"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```
   Add the packaged KaiOS app's own origin to `AllowedOrigins` too, once it's known.
3. Create a Lambda function (e.g. `calorie-counter-api-dev`), Python 3.14 runtime, with the environment variables listed above. Grant its own IAM role `dynamodb:PutItem`/`GetItem`/`UpdateItem`/`Query`/`DeleteItem` on the table, `sqs:SendMessage` on the SMS queue, and `ses:SendEmail`/`ses:SendRawEmail` (scoped to the verified `SES_SENDER_EMAIL` identity) — it needs **no S3 permissions at all**, since every photo operation goes through the separate dedicated presigned credentials instead.
4. Verify an SES sender identity (or the whole domain) for `SES_SENDER_EMAIL` in the SES console — required before `/account/otp` can actually deliver anything. If the SES account is still in the sandbox, recipient addresses need verifying too (or request production access).
5. Create the SES template referenced by `SES_TEMPLATE_NAME` — the JSON is checked in at `backend/calorie-counter-otp-template.json` (a reskin of `kaios-shared-list`'s own OTP template: same structure, calorie-counter branding, green motif, and the account-ID line dropped since nothing else in this app surfaces a user-facing account ID):
   ```
   cd backend/
   aws ses create-template --cli-input-json file://calorie-counter-otp-template.json
   ```
6. Generate `ENCRYPTION_KEY` once (`openssl rand -hex 32`) and set it on the Lambda — see the table above for why losing it is unrecoverable.
7. Set up an API Gateway with an ANY method + proxy integration targeting this Lambda.
8. Run `sh dev-release.sh` (or `prod-release.sh`) to deploy.

**Not a setup step, just worth knowing**: an S3 Lifecycle rule expiring objects in the photos bucket after 30 days (matching the DynamoDB TTL above) keeps an expired submission's photo from lingering indefinitely as orphaned storage once its DynamoDB record is gone.

### Releasing

```
sh dev-release.sh
sh prod-release.sh
```
