# The KaiOS `fetch()` CDN mystery

## TL;DR

On real KaiOS 3.1 hardware (Nokia 2780, Gecko 84), `fetch()` GET requests from
the installed app to our CloudFront+S3 data CDN (`calories.elliscode.com`)
failed with a generic `NetworkError`, while everything else (POST to the API,
direct browser navigation to the same CDN domain) worked fine. We never found
a confirmed root cause. The only fix that actually worked was **switching the
CDN data-sync code (`syncData` / manifest.json + food-data-file downloads) in
`frontend-v3/app.js` from `fetch()` to `XMLHttpRequest`**. If sync-related
CORS/network weirdness shows up again on real devices, this file is the place
to start.

## Symptom

The app's initial data sync (`syncData()` in `app.js`) fetches
`https://calories.elliscode.com/manifest.json`, then each food-data file it
lists, from a CloudFront distribution in front of an S3 bucket. On the Nokia
2780 (KaiOS 3.1, Gecko 84), this consistently failed with:

```
NetworkError when attempting to fetch resource
```

surfaced via the "Last Sync Error" row we added to Options (see below — real
devices on KaiOS 3.0+ have no ADB/remote devtools access, so this was our only
window into what the device was actually seeing). Meanwhile:

- POSTing to `api.calories.elliscode.com/submit` from the same app, same
  device, worked fine (confirmed via a real captured Lambda log line showing
  a correct `Origin: http://caloriecounter.localhost` header).
- Navigating the phone's regular browser directly to
  `https://calories.elliscode.com` (same-origin, not a cross-origin fetch)
  loaded fine.
- Testing the exact same origin/CORS setup via `curl -H "Origin: ..."` from a
  Mac got back a perfectly correct response, with the right
  `Access-Control-Allow-Origin` header for that exact origin.

## What we ruled out, in the order we ruled it out

1. **The app's own origin.** We first suspected the app's origin might not
   really be `http://caloriecounter.localhost` at all (e.g. some KaiOS
   packaged-app-specific `app://...` origin), since `kaios-release.sh` ships
   the app as a sideloaded packaged app and the manifest has no explicit
   `"origin"` override. Ruled out: the real Lambda log for the working
   `/submit` POST showed the literal origin was indeed
   `http://caloriecounter.localhost`.

2. **Mixed content / HTTP vs HTTPS.** Not applicable — mixed-content blocking
   only fires HTTPS-page-loads-HTTP-resource, not the reverse.

3. **Missing/misconfigured S3 bucket CORS.** Checked and iterated on the
   bucket's CORS config (`AllowedOrigins`, tried both explicit origins and
   `*`). Confirmed via direct `curl -H "Origin: ..."` that CloudFront/S3 was
   answering correctly with a matching `Access-Control-Allow-Origin` well
   before the phone started working — so at least by the time of that curl
   test, the bucket-level config wasn't the blocker.

4. **CloudFront not forwarding the `Origin` header to S3** (missing/wrong
   origin-request policy). Same curl test addressed this — a correct
   `Access-Control-Allow-Origin` response proves CloudFront was forwarding
   `Origin` to S3 for at least that request.

5. **CloudFront cache poisoning across origins** (one origin's cached
   response getting served to a different origin because the cache policy
   doesn't vary by `Origin`). Ruled out because caching was outright
   *disabled* on this distribution (`CachingDisabled` managed policy) the
   whole time — every request hits the origin fresh, so there was nothing to
   poison.

6. **Carrier network proxy stripping/mangling headers** (common on feature
   phone data plans). Ruled out — same failure reproduced on WiFi.

7. **CloudFront edge-POP propagation lag** (config change hadn't reached the
   edge location actually serving the phone yet). Plausible early on, but the
   failure persisted well past any reasonable propagation window, on retest,
   over WiFi, on a distribution with caching disabled — so this stopped being
   a satisfying explanation on its own.

8. **KaiOS "web" app-type CSP/permission restrictions.** Checked the
   [KaiOS permission guide](https://kaios.dev/2023/03/complete-kaios-permission-guide/).
   Nothing there differentiates GET vs POST, and nothing covers CSP defaults
   per app type. The one semi-relevant permission, `systemXHR` (lets
   *privileged* apps bypass CORS via `mozSystem`), doesn't apply — this app's
   manifest declares `"type": "web"`, the least-privileged tier, which
   shouldn't get any special treatment either way.

## The theory we thought we'd confirmed, then had to retract

Working theory: **Gecko 84's `fetch()` omits the `Origin` header on GET
requests specifically, but includes it correctly on POST.** This would
tidily explain every symptom (POST works, GET doesn't; curl/browser direct
nav aren't cross-origin `fetch()` calls so they're unaffected).

To test it, we added a throwaway `GET /debug-headers` Lambda route
(`backend/lambda/lambda_function.py`) that echoes back whatever headers it
received, deliberately bypassing the normal domain/CORS gate so it would
respond even if `Origin` were missing — plus an Options-panel button
("Debug: Check Request Headers") to call it from the device and display the
result in a sheet.

First test on-device: **"origin present: NO."** Seemed to confirm the theory.

**This was a false positive.** The Lambda hadn't actually been redeployed yet
at that point (mentioned only after the fact: *"ok i forgot to re-release the
backend so nevermind on the results"*). Hitting an undeployed route falls
through to the router's final catch-all:

```python
return format_response(event=event, http_code=403, body={"message": "Forbidden"})
```

— a response with **no `headers` key at all**. The frontend's check does
`var headers = data.headers || {};`, so a missing `headers` key silently
produces the exact same "origin present: NO" display as a genuine missing
`Origin` header would. Once the Lambda was actually redeployed, **both**
the `fetch()` and `XMLHttpRequest` variants of the same debug button showed
`origin present: yes` — meaning `Origin` was almost certainly being sent
correctly by `fetch()` on GET the whole time. There never was a GET-vs-POST
`Origin`-omission bug.

Caveat worth keeping in mind: that debug route lives on
`api.calories.elliscode.com` (the Lambda/API Gateway), which is a different
domain from the one that was actually failing (`calories.elliscode.com`, the
CloudFront+S3 static data CDN). So even the corrected "yes" result doesn't
directly prove anything about `Origin` handling on the CDN domain
specifically — it only rules out a blanket GET-vs-POST omission bug in this
engine generally.

## Where we landed

We converted the CDN data-sync code path (manifest.json + per-file food data
downloads in `syncData()`, `app.js`) from `fetch()` to a hand-rolled
`xhrGetJson()` built on `XMLHttpRequest`. On the same device, over the same
network, hitting the same CloudFront distribution, **the sync started working
immediately.**

We do not have a confirmed explanation for *why*. Two live theories, neither
proven:

- **Daniel's theory:** some kind of quirky, undocumented `fetch()`-specific
  bug/limitation in this exact engine build (Gecko 84 on KaiOS 3.1) when
  making in-app cross-origin GET requests to this particular CDN setup — CDN
  caching is not the explanation, since caching was disabled on this
  distribution the entire time this was investigated, ruling out the
  cache-poisoning-style theories that would normally be the first suspect for
  a "works from curl, not from the app" split.
- **Claude's theory:** possibly a `fetch()`-specific incompatibility with
  some aspect of CloudFront's response on this old engine (HTTP/2 handling,
  a particular response header combination, streaming body support — the
  original `fetch()`-based sync code used `res.body.getReader()` for progress
  reporting, which is a much newer, less battle-tested API on an engine this
  old than plain XHR's `onprogress` event) that happens to manifest as the
  same generic CORS-shaped `NetworkError` that browsers use for network
  failures generally. Unconfirmed and, on reflection, no more strongly
  evidenced than Daniel's theory — both are guesses.

Either way: **XHR is confirmed working on real hardware, `fetch()` is
confirmed not, for this exact CDN path.** We're keeping XHR and not
re-litigating this further unless it resurfaces.

## Diagnostic tooling left in the app from this investigation

Since KaiOS 3.0+ devices have no ADB/remote devtools access, we built a
couple of permanent on-device diagnostics in Options during this
investigation, which are worth knowing about for future issues:

- **Last Sync Error** (`app.js`: `setLastSyncError`/`getLastSyncError`,
  persisted to `localStorage`) — shows the most recent sync failure's message
  and timestamp, cleared automatically on the next successful sync. Tap it
  to see the full message in a sheet.
- **Debug: Check Headers (fetch)** / **Debug: Check Headers (XHR)** — hit the
  Lambda's `/debug-headers` route (still present in
  `backend/lambda/lambda_function.py`) via each transport and display
  whatever headers the Lambda actually received, specifically flagging
  whether `origin` was present. Useful any time we need to know what a real
  device's request actually looked like server-side, for either transport.

These were left in deliberately rather than ripped out — they cost nothing
at rest and were the only reason we could investigate this at all without
physical device debugging access.
