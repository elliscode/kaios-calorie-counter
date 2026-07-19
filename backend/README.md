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

`lambda/` is a single Lambda function (no framework, plain Python — see `calorie_api/`) behind an API Gateway, structured the same way as `kaios-shared-list/backend`. Two routes, both `POST` only (to avoid CORS preflight — see the comment in `lambda_function.py`):

| Route | Purpose |
|-------|---------|
| `/test` | Health check — returns `{"status": "up"}` |
| `/submit` | Accepts a new food submission from the app's "+ Add New Food" form (`multipart/form-data`: `id`, `name`, `servingQuantity`, `servingName`, `calories`, `fat`, `carbohydrates`, `protein`, optional `photo`), stores it in DynamoDB with `status: "pending"` for manual review, and uploads the photo (if any) to S3 |

### Environment variables

| Variable | Example | Description |
|----------|---------|--------------|
| `DOMAIN_NAMES` | `https://calories.elliscode.com,http://calorie-counter.localhost` | Comma-separated allowlist of `Origin` headers — the web app's domain and the packaged KaiOS app's origin. Any request from an origin not in this list gets a 403. |
| `DYNAMODB_TABLE_NAME` | `kaios-calorie-counter` | The DynamoDB table `/submit` writes submissions to. |
| `PHOTOS_BUCKET_NAME` | `kaios-calorie-counter-submitted-photos` | The private S3 bucket `/submit` uploads nutrition-facts photos to. |

Set these on the Lambda function itself (Configuration → Environment variables in the console, or `--environment` on `aws lambda create-function`/`update-function-configuration`).

### One-time AWS setup

1. Create a DynamoDB table named `kaios-calorie-counter` — partition key `key1` (String), sort key `key2` (String).
2. Create a **private** S3 bucket for submitted nutrition-facts photos (e.g. `kaios-calorie-counter-submitted-photos`) — do **not** reuse the public static-app bucket.
3. Create a Lambda function (e.g. `calorie-counter-api-dev`), Python 3.14 runtime, with the environment variables listed above. Grant its IAM role `dynamodb:PutItem` on the table and `s3:PutObject` on the bucket.
4. Set up an API Gateway with an ANY method + proxy integration targeting this Lambda.
5. Run `sh dev-release.sh` (or `prod-release.sh`) to deploy.

### Releasing

```
sh dev-release.sh
sh prod-release.sh
```

