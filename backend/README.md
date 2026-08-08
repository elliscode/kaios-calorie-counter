# KaiOS Calorie Counter Backend

There's a few files that were used to initially seed the different food databases:

- from here https://fdc.nal.usda.gov/download-datasets

## backend/data-prep/convert_for_kaios_barcode_dynamodb.py

- Formats the "Branded December 2025"
- Data gets put in the Dynamo DB Barcode Lookup DB

## backend/data-prep/convert_foundation_foods_for_kaios_local.py

- Foundation Foods (only like 365 foods)
- Data gets put in the local KaiOS Database
- Data is manually renamed to remove the strange comma formatting (e.g. `Rice, white, long grain, unenriched, raw` --> `White Rice`)

## backend/data-prep/convert_survey_foods_for_kaios_local.py

- FNDDS (around 5k but MANY manually removed)
- Data gets put in the local KaiOS Database
- Data is manually renamed to remove the strange comma formatting (e.g. `Rice, White, Cooked, Glutinous` --> `Cooked White Rice`)

## Add food in the Local Database

I did do this but didnt write about it yet

## Add food in the Dynamo DB

TBD

## Lambda API

`lambda/` is a single Lambda function (no framework, plain Python — see `calorie_api/`) behind an API Gateway, structured the same way as `kaios-shared-list/backend`. Every route is `POST` only (to avoid CORS preflight — see the comment in `lambda_function.py`):

| Route | Purpose |
|-------|---------|
| `/test` | Health check — returns `{"status": "up"}` |
| `/lookup-upc` | Public, no login. Body `{upc}` — looks up a food by barcode in the separate `kaios-calorie-counter-upc-database` table (partition key `upc`, no sort key; see `backend/data-prep/import_barcode_foods_to_dynamo.py`). Normalizes `upc` the same way `backend/data-prep/convert_for_kaios_barcode_dynamodb.py`'s `upc_cleaner` does before the lookup (strips non-digits, left-pads to 12). Returns the stored food (`name`, `upc`, `date`, `servings`) or 404 if that UPC isn't in the table. |
| `/submit` | **Anonymous-friendly** — no login required (see `/account/*` below), but attaches to an account when a valid session is present. Accepts a new food submission from the app's "+ Add New Food" form as plain JSON (`id`, `name`, `servings` — a non-empty array of `{name, quantity, calories, fat, carbohydrates, protein}`, one per serving the user defined — optional `upc`), stores it in DynamoDB with `status: "pending"` and a 30-day TTL for manual review. If logged in, the same food is also upserted into the submitter's own synced foods collection (`user_foods`) in the same call — one action, two effects; anonymously, the food already exists purely locally on the submitter's own device (see `frontend-v3/app.js`'s `submitNewFood`), so there's no account to sync it to. If `upc` is present, it also creates a pending UPC mapping to this food's id + its first serving's name and quantity — see `/admin/add-upc-mapping` below for what that is and why a UPC never lives on the food record itself. |
| `/admin/otp` | Admin login step 1 — texts a one-time code to `ADMIN_PHONE` via the shared SQS-triggered Twilio Lambda |
| `/admin/login` | Admin login step 2 — verifies the code, sets the session cookie + returns a CSRF token |
| `/admin/logged-in-check` | Confirms the current session/cookie is still valid |
| `/admin/pending` | Lists submitted foods still awaiting a decision (`approved` not yet set), **and** pending/approved-not-yet-exported UPC mappings (`pendingUpcMappings`/`approvedUpcMappings`) in the same response, so `admin.html` refreshes both its Foods and UPC Mappings sections from one call |
| `/admin/review` | Accepts or rejects a submission — `id` + `approved` required; `name` and `servings` (the whole array, replacing it) are both optional corrections, only applied if present. Submissions from before this shape existed (flat `servingQuantity`/`servingName`/etc. fields) are read back with a `servings` array synthesized on the fly, so old and new submissions look the same to the admin page. |
| `/admin/export` | Returns every approved-but-not-yet-exported submission as a JSON array in the exact shape of `s3/2026-07-18-base-foods.json`, then marks them `exported: true` so a repeat call returns nothing new |
| `/admin/add-food` | Admin console equivalent of `/submit` — body `{csrf, name, servings, foodId?, upc?}`. Writes into the same `submitted_food` pending queue with the same 30-day TTL. Without `foodId` this is a brand-new food (fresh id generated server-side); with `foodId` set to an *existing* food's real id, it's instead "add these new serving(s) to that food" — the pending item holds only the new servings, under the existing id, for a future local-catalog merge to append rather than duplicate. If `upc` is present, also creates a pending UPC mapping (to this call's `foodId`/fresh id + the first serving in `servings`, name and quantity both), same as `/submit`. Used by `admin.html`'s "+ Add Food" button and the "Scan Barcode" → "new food" / "new serving size" paths. |
| `/admin/add-upc-mapping` | Body `{csrf, upc, foodId, foodName, servingName, servingQuantity}`, all required. Directly creates a pending UPC mapping with no food/serving submission involved — used when "Scan Barcode" resolves to a food + serving that already exist exactly as-is. See the UPC mappings note below. |
| `/admin/review-upc-mapping` | Accepts or rejects a pending UPC mapping — `upc` + `approved` required; `foodId`/`foodName`/`servingName`/`servingQuantity` are optional corrections, same pattern as `/admin/review`. |
| `/admin/export-upc-mappings` | Returns every approved-but-not-yet-exported UPC mapping as a JSON array of `{upc, foodId, servingName, servingQuantity}` (no `foodName` — that's stored only for display in `admin.html`), then marks them `exported: true`. |
| `/account/otp` | End-user login step 1 — emails a one-time code to whatever address the client supplies, via SES. An account is implicitly created on first use — there's no separate signup |
| `/account/login` | End-user login step 2 — verifies the code, sets the session cookie + returns a CSRF token |
| `/account/logged-in-check` | Confirms the current end-user session/cookie is still valid |
| `/account/log-out-all` | Invalidates every active session for the logged-in user (sign out everywhere, not just this device) |
| `/account/refresh` | Extends the current session's expiration (another 4 months) and re-issues the cookie with the new date — meant to be called periodically by a client still in active use, so a long-lived install never gets silently logged out |
| `/sync/foods` | **Login required.** Body `{csrf, foods: {foodId: {...}}}` — merges the client's custom-foods collection against what's stored for this account (newer `updated` timestamp wins per food, whole item as a unit) and returns the merged result |
| `/sync/diary` | **Login required.** Body `{csrf, date: "YYYY-MM-DD", entries: {entryId: {...}}}` — merges and returns exactly one calendar date's diary entries; never reads or writes any other date |
| `/sync/preferences` | **Login required.** Body `{csrf, settings?, lastServings?, usageCounts?}` — each key is optional and merged independently (the `showCaffeine` setting, last-used-serving-per-food, and per-food usage counts) |

`admin.html` (`s3/admin.html`) is the actual review UI — a phone-OTP-gated page for approving/rejecting/correcting submissions and triggering exports, ported from `kaios-t9-wizard`'s admin login pattern.

### UPC mappings

A barcode maps to three things — a food, a serving name, **and** a serving quantity — never to a food alone: many products (different sizes, regional packaging, etc.) legitimately share one underlying food, differing only in which serving they represent. So a UPC never lives on a food record itself; it's tracked as its own record type, a mapping of `upc -> (foodId, servingName, servingQuantity)`, stored the same way as `submitted_food` (`key1: "upc_mapping"`, `key2: upc`, same pending/approved/exported lifecycle, same 30-day TTL via `create_upc_mapping` in `calorie_api/utils.py`) but reviewed and exported completely separately from foods, producing its own JSON artifact (`{upc, foodId, servingName, servingQuantity}[]`, via `/admin/export-upc-mappings`) imported separately from the foods export.

`servingQuantity` is a *modifiable* amount, not required to equal the target serving's own quantity on the food — e.g. a food's "g" serving might be defined at 100g, but a scanned product's actual package is 59g, so the mapping records `servingName: "g", servingQuantity: 59`. Nothing on the backend scales anything; `servingQuantity`/`servingName`/`foodId` are stored and passed through completely as-is. `admin.html`'s live preview is what does the scaling, client-side, by looking up the target serving's base values (by `foodId` + `servingName` only, not quantity) and multiplying by `servingQuantity / baseServing.quantity` — same ratio math `backend/data-prep/convert_for_kaios_barcode_dynamodb.py` uses to derive a product's serving from its 100g reference.

`kaios-calorie-counter-upc-database` (the remote table behind `/lookup-upc`) is unrelated to this — that's still just "what does this barcode's product record say nutritionally," used as a prefill aid when resolving a scan, not the source of truth for what a UPC means in this app's own catalog.

### End-user accounts and sync

Logging in is entirely optional for using the app — diary, browsing the catalog, creating a custom food, all of it works fully anonymously. Admin review is the actual spam gate on the moderation queue, not login. Logging in just attaches a submission to an account (see `/submit` above) and enables multi-device sync via `/sync/*` below.

Every synced item (`user_foods`, `user_diary`, `user_preferences`) is stored **encrypted at rest** — a lightweight stdlib cipher (SHA256-counter-mode keystream, ported from `kaios-shared-list`), keyed by `ENCRYPTION_KEY` below — so a DynamoDB console browse never shows readable diary/food/settings content, only ciphertext. It's an obfuscation layer, not a hardened one: anyone with the code and the key can decrypt, same as the sibling project it's ported from.

Sync uses the same reconciliation approach as `kaios-shared-list`: each sync route loads the account's current stored collection, merges the client's payload item-by-item (whichever side has the newer `updated` timestamp wins, whole item as a unit), stores the merged result, and returns it — the client is expected to replace its local copy with the response. Deletions are tombstones (`deleted: true` with a fresh `updated`), purged from storage 120 days after their `updated` time.

### Environment variables

| Variable | Example | Description |
|----------|---------|--------------|
| `DOMAIN_NAMES` | `https://calories.elliscode.com,http://calorie-counter.localhost` | Comma-separated allowlist of `Origin` headers — the web app's domain and the packaged KaiOS app's origin. Any request from an origin not in this list gets a 403. |
| `DYNAMODB_TABLE_NAME` | `kaios-calorie-counter` | The DynamoDB table every route reads/writes. |
| `UPC_TABLE_NAME` | `kaios-calorie-counter-upc-database` | The separate barcode-lookup table `/lookup-upc` reads (partition key `upc` only, no sort key) — not the same table as `DYNAMODB_TABLE_NAME` above. |
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
2. Create a Lambda function (e.g. `calorie-counter-api-dev`), Python 3.14 runtime, with the environment variables listed above. Grant its own IAM role `dynamodb:PutItem`/`GetItem`/`UpdateItem`/`Query`/`DeleteItem` on the table, plus `dynamodb:GetItem` on the separate `UPC_TABLE_NAME` table (read-only, since `/lookup-upc` never writes to it), and `sqs:SendMessage` on the SMS queue, and `ses:SendEmail`/`ses:SendRawEmail` (scoped to the verified `SES_SENDER_EMAIL` identity) — it needs **no S3 permissions at all**.
3. Verify an SES sender identity (or the whole domain) for `SES_SENDER_EMAIL` in the SES console — required before `/account/otp` can actually deliver anything. If the SES account is still in the sandbox, recipient addresses need verifying too (or request production access).
4. Create the SES template referenced by `SES_TEMPLATE_NAME` — the JSON is checked in at `backend/calorie-counter-otp-template.json` (a reskin of `kaios-shared-list`'s own OTP template: same structure, calorie-counter branding, green motif, and the account-ID line dropped since nothing else in this app surfaces a user-facing account ID):
   ```
   cd backend/
   aws ses create-template --cli-input-json file://calorie-counter-otp-template.json
   ```
5. Generate `ENCRYPTION_KEY` once (`openssl rand -hex 32`) and set it on the Lambda — see the table above for why losing it is unrecoverable.
6. Set up an API Gateway with an ANY method + proxy integration targeting this Lambda.
7. Run `sh dev-release.sh` (or `prod-release.sh`) to deploy.

### Releasing

```
sh dev-release.sh
sh prod-release.sh
```
