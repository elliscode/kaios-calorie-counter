# KaiOS Calorie Counter

A calorie-counting app for KaiOS feature phones, backed by a food catalog seeded from USDA data (FNDDS + Branded datasets), a Lambda API, and DynamoDB. Optional accounts let diary/foods/recipes/preferences sync across devices — the app is fully usable anonymously, including submitting a food to the shared public catalog; logging in just enables multi-device sync.

## Repo layout

| Path | What it is |
|---|---|
| `frontend-v3/` | The KaiOS app itself — plain JS, no framework, no build step. See `frontend-v3/README.md`. |
| `backend/` | The Lambda API (accounts, sync, catalog submission/moderation) + DynamoDB + the one-time data-prep scripts that built the seed catalog. See `backend/README.md`. |
| `s3/` | Static hosting root for the deployed app, the food catalog data files/manifest, and the admin review tool (`admin.html`). |
| `notes/` | Ad-hoc investigation writeups (e.g. a fetch-vs-XHR CORS debugging session on real hardware). |
| `art/` | Icon/branding source assets. |

## Features

**For users, all reachable from Search's "+ Add…" rows:**
- **Diary** — log foods against any date, with running calorie/fat/carb/protein (and optional caffeine) totals.
- **Search** — thousands of USDA-sourced foods, ranked by how often you actually use them.
- **+ Add new food** — submit a custom food (name, servings, optional extra servings) for the shared catalog, fully anonymously; admin review is the actual spam gate on the moderation queue, not login. Logging in attaches the submission to an account instead of leaving it purely local.
- **+ Add new recipe** — combine several existing foods, each at its own specific quantity, divided across a servings count, into one reusable food. Nutrition is baked in once at save time, not recomputed later.
- **+ Add guesstimate** — a two-field (name + calories) one-off log entry for vague in-the-moment estimates that don't need to become a searchable food.
- **Optional account** (email + one-time code, no password) — syncs diary, custom foods, recipes, and preferences across devices using a last-write-wins merge per item. Logging in is never required for anything in the app.
- **My Foods / My Recipes** (Options) — manage what you've created; My Foods shows each submission's status (Local / Approval Pending / Approved / Rejected), computed entirely on-device from whether the food shows up in the downloaded catalog and how long it's been since submission.

**For catalog moderation:**
- `s3/admin.html` — a phone-OTP-gated review tool for approving/rejecting/correcting submitted foods and exporting approved ones into the published catalog.

## Architecture

```
KaiOS app (frontend-v3/)
  ├─ static catalog data (calories.elliscode.com, S3) — manifest.json + dated food files, no auth
  └─ API (api.calories.elliscode.com, Lambda + API Gateway + DynamoDB)
       ├─ /submit                             — custom food submission (anonymous-friendly)
       ├─ /account/*                          — email OTP login, session refresh
       ├─ /sync/foods, /sync/diary, /sync/preferences  — per-account multi-device sync
       └─ /admin/*                            — moderation (separate phone-OTP admin login)
```

Every synced item (foods, diary entries, preferences) is stored encrypted at rest in DynamoDB — an obfuscation layer, not a hardened security boundary, so a database browse never shows readable content.

## Backend

Single Python Lambda (no framework), one DynamoDB table (`key1`/`key2` single-table design), no build step. Full route list, environment variables, and one-time AWS setup steps are in `backend/README.md`.

```
cd backend && sh prod-release.sh
```

## Frontend

Single-file SPA (`frontend-v3/index.html` + `app.js`), D-pad/softkey navigation, IndexedDB for local storage, no framework or build step — same approach as this project's `kaios-shared-list` sibling. Panel list, D-pad control reference, and testing instructions are in `frontend-v3/README.md`.

```
cd frontend-v3 && npx playwright test   # 88 tests
cd s3 && sh release.sh                  # deploy app + catalog data to calories.elliscode.com
cd frontend-v3 && sh kaios-release.sh   # package a zip for KaiStore submission
```
