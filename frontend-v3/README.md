# frontend-v3 — KaiOS Calorie Counter

KaiOS-only frontend for the calorie counter. Single-file SPA, plain JavaScript, no build step, no framework — same approach as `kaios-shared-list/frontend-v3`. Two independent data sources: a static food catalog served from `calories.elliscode.com` (no auth, always available offline-first), and a Lambda API at `api.calories.elliscode.com` (`../backend/`) for optional accounts, multi-device sync, and custom-food submission.

## Structure

```
frontend-v3/
  index.html              — every panel in one file
  app.js                  — navigation, IndexedDB, catalog + account sync, all screen logic
  css/
    root.css               — base layout, panel show/hide, hint/link styles
    header.css              — green title bars + the persistent login status dot
    softkey.css             — fixed 30px bottom softkey bar, hidden above 240px
    input.css                — floating-label inputs, buttons, extra-serving blocks
    list.css                  — diary/search/options rows, summary + nutrient tables, recipe tag
    sheet.css                  — bottom sheet (confirmations, action menus)
    loader.css                  — initial loading screen / spinner
  tests/
    fixtures/               — small sample manifest.json + foods file for Playwright
    *.spec.js                — 88 tests across 21 files
```

## Screens

| Panel | Description |
|-------|-------------|
| Diary | Date picker + logged foods for that day + daily totals |
| Search | Find catalog/custom foods/recipes; queue several via the Tray, or add one directly. "+ Add new food" / "+ Add new recipe" / "+ Add guesstimate" always sit at the bottom |
| Servings | Adjust quantity/unit for a diary entry, view the full nutrient breakdown, delete. Doubles as the "how much of this ingredient" picker when building a recipe |
| New Food | Submit a custom food (name, servings, optional extra servings, optional nutrition-facts photo) — requires login |
| Recipe Builder | Name a recipe, add ingredients (each at its own quantity via Search → Servings), set a servings count; bakes nutrition-per-serving once at save |
| Guesstimate | Two fields only — name + a calorie guess — for a fast, one-off diary entry that never becomes a searchable food |
| Options | App version, login status, Show Caffeine toggle, My Foods, My Recipes, Clear Local DB |
| My Foods | Foods you've submitted, with computed status (Local / Approval Pending / Approved / Rejected); delete or re-submit |
| My Recipes | Recipes you've created; delete |
| Log In (email / code) | Email + one-time code — optional everywhere except submitting a new food |

Navigation is purely panel-based — no page loads, same pattern as the shared-list reference app.

## D-pad & Softkey Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between items |
| `Enter` / Center softkey | Activate focused item |
| Left softkey | Back / cancel on every screen except Diary (its root panel has none — `Backspace` there exits the app instead) |
| Right softkey | Context-dependent (Options, Tray, Delete — see table below) |
| `Backspace` | Same as left softkey, except on the root Diary panel where it lets KaiOS exit the app |

Softkey labels are context-sensitive, not fixed per screen — Search and Servings both flip into a different mode (and different softkey labels) while picking an ingredient for a recipe.

### Softkeys by screen

| Screen | Left | Center | Right |
|--------|------|--------|-------|
| Diary | — | Add / Edit | Options |
| Search (normal) | Back | Add (N) | Tray |
| Search (picking a recipe ingredient) | Back | Select | — |
| Servings (editing a diary entry) | Back | Save | Delete |
| Servings (picking an ingredient's quantity) | Back | Add | — |
| New Food | Back | Next / Submit | — |
| Recipe Builder | Back | Next / Save Recipe | — |
| Guesstimate | Back | Next / Add | — |
| Options / My Foods / My Recipes | Back | SELECT | — |
| Log In — email | Back | Next | — |
| Log In — code | Back | Verify | — |

## Data

### Catalog sync (always on, no login)

On launch the app fetches `https://calories.elliscode.com/manifest.json`, diffs its file list against an IndexedDB `syncedFiles` store, and downloads only files it hasn't already merged into the `foods` store — throttled to roughly once a week (or immediately after a local DB clear) rather than every launch. If the fetch fails (offline), the app proceeds with whatever's already cached — it never blocks on the network. Search filters an in-memory copy of `foods` (loaded once per session) rather than querying IndexedDB per keystroke.

### Account sync (optional, login required)

Logging in (Options → the login row) is email + a one-time code, no password. Once logged in, `foods`, `diary` (one calendar date at a time), and `preferences` (the Show Caffeine setting, last-used servings, usage counts) each sync against the account independently — last-write-wins per item, by an `updated` timestamp, mirroring `kaios-shared-list`'s own reconciliation model. Deletions become tombstones once a device has ever logged in, so a delete on one device correctly propagates to others; a device that's never logged in just does real local deletes, since there's nothing to reconcile. See `../backend/README.md` for the actual `/sync/*` routes.

### IndexedDB stores

`foods` (catalog + custom foods + recipes, keyed by id — `source`/`type` fields distinguish where a record came from), `diary` (one row per logged entry, denormalized/self-contained, keyed by a local autoincrement id plus a separate cross-device `guid`), `mySubmissions` (local-only bookkeeping for My Foods' status computation), `usageCounts`, `lastServings`, `syncedFiles` (catalog download bookkeeping, never synced to an account).

## Deploying

- **Web (app + data, one script)**: `cd ../s3 && sh release.sh` — copies `index.html`, `app.js`, and `css/` in from `frontend-v3/` every run, then syncs the whole `s3/` directory (app files + manifest + dated food files) to the bucket in one shot.
- **KaiOS store submission (zip)**: `cd frontend-v3 && sh kaios-release.sh` — packages this directory for KaiStore upload; unrelated to the S3 sync above.
- The backend (`api.calories.elliscode.com`) deploys separately — see `../backend/README.md`. Account/sync/submission features need it up; the catalog and offline diary logging don't.

The bucket must have CORS enabled for cross-origin `GET` so the packaged KaiOS app (running from a different origin) can fetch the manifest and data files.

## Testing

```
npm install
npx playwright test
```

Tests intercept `DATA_HOST`/API requests with `page.route()` and serve `tests/fixtures/manifest.json` / `sample-foods.json` — no live network calls, since neither the production data host nor the backend needs to be up for the suite to pass.

## Kaios Submission Fields

### Known Issues

No known issues at this time

### Simple Test Report

1. Open the app, observe the food databases get downloaded on initial opening.
2. Add a food by pressing "+ Add Food", search for it, and use the arrow keys to pick a result and press select to add it.
3. Try "+ Add new food" / "+ Add new recipe" / "+ Add guesstimate" at the bottom of Search results — the first two require logging in (Options → the login row → email + the one-time code sent to it); guesstimates don't.
4. Open a logged entry from the Diary to adjust its quantity or delete it.
