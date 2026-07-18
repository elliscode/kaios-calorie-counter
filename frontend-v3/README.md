# frontend-v3 — KaiOS Calorie Counter

KaiOS-only frontend for the calorie counter, backed entirely by static JSON files at `calories.elliscode.com` (no backend/API). Single-file SPA, plain JavaScript, no build step, no framework — same approach as `kaios-shared-list/frontend-v3`.

## Structure

```
frontend-v3/
  index.html              — all three panels in one file
  app.js                  — navigation, IndexedDB sync, state
  css/
    root.css               — base layout, panel show/hide
    header.css              — purple title bars
    softkey.css             — fixed 30px bottom softkey bar, hidden above 240px
    input.css                — floating-label inputs + the plain search box
    list.css                  — diary/search rows, summary + nutrient tables
  tests/
    fixtures/               — small sample manifest.json + foods file for Playwright
    *.spec.js
```

## Screens

| Panel | Description |
|-------|-------------|
| Diary | Date picker + today's logged foods + daily totals |
| Search | Find foods from the local cache, queue several via the Tray, or add one directly |
| Servings | Adjust quantity/unit for one diary entry, view full nutrient breakdown, delete |
| Options | App version for now; a natural home for account sync later |

Navigation is purely panel-based — no page loads, same pattern as the shared-list reference app.

## D-pad & Softkey Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between items |
| `Enter` / Center softkey | Activate focused item |
| Left softkey | Search (Diary) · Back / cancel (Search, Servings, Options) |
| Right softkey | Options (Diary) · Add to Tray (Search) · Delete (Servings) |
| `Backspace` | Same as left softkey, except on the root Diary panel where it lets KaiOS exit the app |

### Softkeys by screen

| Screen | Left | Center | Right |
|--------|------|--------|-------|
| Diary | Search | Edit | Options |
| Search | Back | Add (N) | Tray |
| Servings | Back | Save | Delete |
| Options | Back | SELECT | — |

## Data sync

On launch the app fetches `https://calories.elliscode.com/manifest.json`, diffs its file list against an IndexedDB `syncedFiles` store, and downloads only files it hasn't already merged into the `foods` store. If the manifest fetch fails (offline), the app proceeds with whatever's already cached — it never blocks on the network.

Search filters an in-memory copy of `foods` (loaded once per session) rather than querying IndexedDB per keystroke — simple substring match, fast enough at this record count (a few thousand foods).

## Deploying

- **Web (app + data, one script)**: `cd ../s3 && sh release.sh` — copies `index.html`, `app.js`, and `css/` in from `frontend-v3/` every run, then syncs the whole `s3/` directory (app files + manifest + dated food files) to the bucket in one shot.
- **KaiOS store submission (zip)**: `cd frontend-v3 && sh kaios-release.sh` — packages this directory for KaiStore upload; unrelated to the S3 sync above.

The bucket must have CORS enabled for cross-origin `GET` so the packaged KaiOS app (running from a different origin) can fetch the manifest and data files.

## Testing

```
npm install
npx playwright test
```

Tests intercept `DATA_HOST` requests with `page.route()` and serve `tests/fixtures/manifest.json` / `sample-foods.json` — no live network calls, since the production data host isn't required to be up for the suite to pass.
