'use strict';

var DATA_HOST = 'https://calories.elliscode.com';
var API_HOST = 'https://api.calories.elliscode.com';
var SUBMIT_URL = API_HOST + '/submit';
var PRESIGNED_POST_URL = API_HOST + '/presigned-post';
var ACCOUNT_OTP_URL = API_HOST + '/account/otp';
var ACCOUNT_LOGIN_URL = API_HOST + '/account/login';
var ACCOUNT_LOG_OUT_ALL_URL = API_HOST + '/account/log-out-all';
var ACCOUNT_REFRESH_URL = API_HOST + '/account/refresh';
var SYNC_FOODS_URL = API_HOST + '/sync/foods';
var SYNC_DIARY_URL = API_HOST + '/sync/diary';
var SYNC_PREFERENCES_URL = API_HOST + '/sync/preferences';
// Must track backend/lambda/calorie_api/sync.py's DELETED_ITEM_RETENTION_DAYS —
// local tombstones are purged on the same schedule the server purges its own,
// so a device that's been offline a while doesn't hang onto dead rows any
// longer than the server would anyway.
var TOMBSTONE_RETENTION_DAYS = 120;
var APP_VERSION = '3.0.6';

var SUMMARY_KEYS = ['calories', 'fat', 'carbohydrates', 'protein', 'caffeine'];
var NON_NUTRIENT_KEYS = ['id', 'date', 'foodId', 'foodName', 'servingName', 'quantity', 'name'];

var state = {
  currentDate: todayStr(),
  allFoods: [],
  foodsById: {},
  usageCounts: {},
  lastServings: {},
  tray: [],
  diaryEntries: [],
  editingEntry: null,
  editingFood: null
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayStr() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function formatQty(qty) {
  return String(round2(qty));
}

function humanizeKey(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) { return c.toUpperCase(); });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// A user-created food's id is a version-4 UUID (see generateGuid() above,
// the literal "4" nibble + the "8/9/a/b" variant nibble); every catalog
// (manifest-seeded) food id is a version-5 UUID instead (deterministic,
// backend/data-prep/convert_for_kaios_local.py's uuid.uuid5(...)) — this is
// a 100%-reliable discriminator, not a heuristic, used only for the one-time
// v4 DB migration backfill to tell pre-existing custom foods apart from
// catalog foods (there was no `source` field before this migration).
var LOCAL_FOOD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Random per-submission id for custom foods — deliberately NOT seeded from the
// name (unlike the Python data-prep GUIDs), since the name can still be
// corrected during review after this id has already been handed out. No
// crypto.randomUUID() dependency, since this targets an old Gecko build.
function generateGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ─── Last sync error (surfaced in Options — the only diagnostic tool we have
// on real KaiOS 3.0 hardware, since ADB/remote devtools aren't available on
// those devices) ────────────────────────────────────────────────────────────
function setLastSyncError(msg) {
  try {
    if (msg) {
      localStorage.setItem('lastSyncError', JSON.stringify({ message: msg, at: new Date().toISOString() }));
    } else {
      localStorage.removeItem('lastSyncError');
    }
  } catch (e) { /* localStorage unavailable — nothing we can do */ }
}

function getLastSyncError() {
  try {
    var raw = localStorage.getItem('lastSyncError');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ─── Show Caffeine setting ──────────────────────────────────────────────
// Caffeine has no input on the "+ Add New Food" form (only an admin can
// ever set it, during review) — most foods just show "0 mg", which not
// everyone cares to see, so it's a togglable row in Options. Defaults to
// off.
function getShowCaffeine() {
  try {
    var raw = localStorage.getItem('showCaffeine');
    return raw === null ? false : raw === 'true';
  } catch (e) { return false; }
}

function getShowCaffeineUpdatedAt() {
  try { return parseInt(localStorage.getItem('showCaffeineUpdatedAt'), 10) || 0; } catch (e) { return 0; }
}

function setShowCaffeineUpdatedAt(ts) {
  try { localStorage.setItem('showCaffeineUpdatedAt', String(ts)); } catch (e) { /* ignore */ }
}

function setShowCaffeine(show) {
  try { localStorage.setItem('showCaffeine', String(show)); } catch (e) { /* ignore */ }
  setShowCaffeineUpdatedAt(nowSec());
  applyCaffeineVisibility();
  syncPreferences();
}

function applyCaffeineVisibility() {
  var display = getShowCaffeine() ? '' : 'none';
  var rowSum = document.getElementById('row-sum-caffeine');
  var rowServ = document.getElementById('row-serv-caffeine');
  if (rowSum) rowSum.style.display = display;
  if (rowServ) rowServ.style.display = display;
}

// ─── Account session (email OTP login) ─────────────────────────────────────
// The session itself lives in an HttpOnly cookie the browser handles
// automatically — this app never reads/writes that cookie directly. The
// CSRF token, though, is only ever handed to us once (a response header on
// /account/login) and has to be resent by us on every authenticated call
// (double-submit pattern, see backend/lambda/calorie_api/utils.py's
// authenticate_user), so it's the one piece of session state we do persist
// ourselves. Its mere presence is also how this app answers "am I logged
// in?" without a network round trip.
function getCsrf() {
  try { return localStorage.getItem('csrf'); } catch (e) { return null; }
}

function setCsrf(csrf) {
  try { localStorage.setItem('csrf', csrf); } catch (e) { /* ignore */ }
}

function clearCsrf() {
  try { localStorage.removeItem('csrf'); } catch (e) { /* ignore */ }
}

function isLoggedIn() {
  return !!getCsrf();
}

// Set once on first successful login, never cleared by logout — this is
// what decides whether local deletes become sync-able tombstones (see
// dbSoftDeleteDiaryEntry/dbSoftDeleteFood) rather than real deletes. A
// device that's never logged in has nothing to reconcile, so there's no
// reason to keep tombstones around at all on it.
function getEverLoggedIn() {
  try { return localStorage.getItem('everLoggedIn') === 'true'; } catch (e) { return false; }
}

function markEverLoggedIn() {
  try { localStorage.setItem('everLoggedIn', 'true'); } catch (e) { /* ignore */ }
}

function setAuthDotState() {
  var on = isLoggedIn();
  var dots = document.querySelectorAll('.auth-dot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].classList.toggle('auth-dot-on', on);
  }
  var labels = document.querySelectorAll('.auth-status-text');
  for (var j = 0; j < labels.length; j++) {
    labels[j].textContent = on ? 'Logged In' : 'Logged Out';
  }
}

var _statusTimer = null;
function showStatus(msg, isError) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status-toast ' + (isError ? 'error' : 'info');
  el.setAttribute('visible', 'true');
  clearTimeout(_statusTimer);
  _statusTimer = setTimeout(function () {
    el.removeAttribute('visible');
  }, 2500);
}

// ─── IndexedDB persistence ────────────────────────────────────────────────────

var db = null;
var DB_NAME = 'kaios-calorie-counter';
var DB_VERSION = 4;

function openDB(callback) {
  var req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = function (e) {
    var d = e.target.result;
    var tx = e.target.transaction;

    var foodsStore;
    if (!d.objectStoreNames.contains('foods')) {
      foodsStore = d.createObjectStore('foods', { keyPath: 'id' });
    } else {
      foodsStore = tx.objectStore('foods');
    }

    var diaryStore;
    if (!d.objectStoreNames.contains('diary')) {
      diaryStore = d.createObjectStore('diary', { keyPath: 'id', autoIncrement: true });
      diaryStore.createIndex('byDate', 'date', { unique: false });
    } else {
      diaryStore = tx.objectStore('diary');
    }

    if (!d.objectStoreNames.contains('syncedFiles')) {
      d.createObjectStore('syncedFiles', { keyPath: 'id' });
    }

    var usageStore;
    if (!d.objectStoreNames.contains('usageCounts')) {
      usageStore = d.createObjectStore('usageCounts', { keyPath: 'id' });
      // Backfill from any diary entries that already existed before this
      // store did, so upgrading devices don't start every food at zero.
      diaryStore.getAll().onsuccess = function (ev) {
        var counts = {};
        (ev.target.result || []).forEach(function (entry) {
          counts[entry.foodId] = (counts[entry.foodId] || 0) + 1;
        });
        Object.keys(counts).forEach(function (foodId) {
          usageStore.put({ id: foodId, count: counts[foodId], updated: nowSec() });
        });
      };
    } else {
      usageStore = tx.objectStore('usageCounts');
    }

    var lastServingStore;
    if (!d.objectStoreNames.contains('lastServings')) {
      lastServingStore = d.createObjectStore('lastServings', { keyPath: 'id' });
      // Backfill from any diary entries that already existed before this
      // store did, using each food's most recently-added entry (autoIncrement
      // ids are monotonically increasing), so upgrading devices start out
      // remembering real history instead of falling back to each food's base
      // serving on the very first add after the upgrade.
      diaryStore.getAll().onsuccess = function (ev) {
        var latestByFood = {};
        (ev.target.result || []).forEach(function (entry) {
          var existing = latestByFood[entry.foodId];
          if (!existing || entry.id > existing.id) {
            latestByFood[entry.foodId] = entry;
          }
        });
        Object.keys(latestByFood).forEach(function (foodId) {
          var entry = latestByFood[foodId];
          lastServingStore.put({ id: foodId, servingName: entry.servingName, quantity: entry.quantity, updated: nowSec() });
        });
      };
    } else {
      lastServingStore = tx.objectStore('lastServings');
    }

    // v4: accounts/sync. New store for per-food submission bookkeeping (see
    // "My Foods" screen) — deliberately separate from `foods` itself, since
    // an approved+exported food's `foods` record gets overwritten by the
    // normal catalog sync under the same id, and this bookkeeping needs to
    // survive that overwrite.
    var mySubmissionsStore;
    if (!d.objectStoreNames.contains('mySubmissions')) {
      mySubmissionsStore = d.createObjectStore('mySubmissions', { keyPath: 'id' });
    } else {
      mySubmissionsStore = tx.objectStore('mySubmissions');
    }

    if (e.oldVersion < 4) {
      // Backfill `foods` with the fields sync/status computation now needs.
      // Pre-v4 records have no way to tell "I created this locally" apart
      // from "this came from the catalog" — the id's UUID version nibble
      // does (see LOCAL_FOOD_ID_REGEX) — so only records that look
      // user-created get a mySubmissions row; anything else is left as-is
      // and will be fully overwritten by the next catalog sync regardless.
      foodsStore.getAll().onsuccess = function (ev) {
        (ev.target.result || []).forEach(function (food) {
          if (food.source) return; // already migrated
          var isLocal = LOCAL_FOOD_ID_REGEX.test(food.id);
          food.source = isLocal ? 'local' : 'catalog';
          food.updated = nowSec();
          food.deleted = false;
          foodsStore.put(food);
          if (isLocal) {
            mySubmissionsStore.put({ id: food.id, createdAt: nowSec(), submittedAt: null, submitStatus: 'local' });
          }
        });
      };

      // Backfill `diary` with a stable cross-device guid + sync bookkeeping.
      // `id` (autoincrement) stays the real local key — untouched, still
      // used everywhere it already was — `guid` is purely the /sync/diary
      // merge key.
      diaryStore.getAll().onsuccess = function (ev) {
        (ev.target.result || []).forEach(function (entry) {
          if (entry.guid) return; // already migrated
          entry.guid = generateGuid();
          entry.updated = entry.updated || nowSec();
          entry.deleted = false;
          diaryStore.put(entry);
        });
      };

      // A pre-existing v3 install already has real usageCounts/lastServings
      // data (from its own earlier v2->v3 backfill, or ordinary use since
      // then) — this just adds the `updated` field /sync/preferences needs,
      // it doesn't re-derive anything from diary history again.
      usageStore.getAll().onsuccess = function (ev) {
        (ev.target.result || []).forEach(function (rec) {
          if (rec.updated) return;
          rec.updated = nowSec();
          usageStore.put(rec);
        });
      };
      lastServingStore.getAll().onsuccess = function (ev) {
        (ev.target.result || []).forEach(function (rec) {
          if (rec.updated) return;
          rec.updated = nowSec();
          lastServingStore.put(rec);
        });
      };
    }
  };
  req.onsuccess = function (e) {
    db = e.target.result;
    callback(null);
  };
  req.onerror = function () {
    callback(req.error);
  };
}

function dbGetSyncedFileIds(callback) {
  var tx = db.transaction('syncedFiles', 'readonly');
  var req = tx.objectStore('syncedFiles').getAll();
  req.onsuccess = function () {
    callback((req.result || []).map(function (r) { return r.id; }));
  };
  req.onerror = function () { callback([]); };
}

function dbMarkFileSynced(id, callback) {
  var tx = db.transaction('syncedFiles', 'readwrite');
  tx.objectStore('syncedFiles').put({ id: id, syncedAt: Date.now() });
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbBulkPutFoods(foodsArray, callback) {
  var tx = db.transaction('foods', 'readwrite');
  var store = tx.objectStore('foods');
  foodsArray.forEach(function (f) { store.put(f); });
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbGetAllFoods(callback) {
  var tx = db.transaction('foods', 'readonly');
  var req = tx.objectStore('foods').getAll();
  req.onsuccess = function () { callback(req.result || []); };
  req.onerror = function () { callback([]); };
}

function dbGetFood(id, callback) {
  var tx = db.transaction('foods', 'readonly');
  var req = tx.objectStore('foods').get(id);
  req.onsuccess = function () { callback(req.result || null); };
  req.onerror = function () { callback(null); };
}

function dbGetDiaryByDate(date, callback) {
  var tx = db.transaction('diary', 'readonly');
  var req = tx.objectStore('diary').index('byDate').getAll(IDBKeyRange.only(date));
  req.onsuccess = function () { callback(req.result || []); };
  req.onerror = function () { callback([]); };
}

function dbAddDiaryEntry(entry, callback) {
  var tx = db.transaction('diary', 'readwrite');
  var req = tx.objectStore('diary').add(entry);
  req.onsuccess = function () { callback(req.result); };
  req.onerror = function () { callback(null); };
}

function dbUpdateDiaryEntry(id, updatedEntry, callback) {
  updatedEntry.id = id;
  var tx = db.transaction('diary', 'readwrite');
  var req = tx.objectStore('diary').put(updatedEntry);
  req.onsuccess = function () { callback(); };
  req.onerror = function () { callback(); };
}

function dbDeleteDiaryEntry(id, callback) {
  var tx = db.transaction('diary', 'readwrite');
  tx.objectStore('diary').delete(id);
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbGetAllUsageCounts(callback) {
  var tx = db.transaction('usageCounts', 'readonly');
  var req = tx.objectStore('usageCounts').getAll();
  req.onsuccess = function () { callback(req.result || []); };
  req.onerror = function () { callback([]); };
}

function dbIncrementUsageCount(foodId, callback) {
  var tx = db.transaction('usageCounts', 'readwrite');
  var store = tx.objectStore('usageCounts');
  var req = store.get(foodId);
  req.onsuccess = function () {
    var rec = req.result || { id: foodId, count: 0 };
    rec.count += 1;
    store.put(rec);
  };
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbDecrementUsageCount(foodId, callback) {
  var tx = db.transaction('usageCounts', 'readwrite');
  var store = tx.objectStore('usageCounts');
  var req = store.get(foodId);
  req.onsuccess = function () {
    var rec = req.result;
    if (rec) {
      rec.count = Math.max(0, rec.count - 1);
      store.put(rec);
    }
  };
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbGetAllLastServings(callback) {
  var tx = db.transaction('lastServings', 'readonly');
  var req = tx.objectStore('lastServings').getAll();
  req.onsuccess = function () { callback(req.result || []); };
  req.onerror = function () { callback([]); };
}

function dbSetLastServing(foodId, servingName, quantity, callback) {
  var tx = db.transaction('lastServings', 'readwrite');
  tx.objectStore('lastServings').put({ id: foodId, servingName: servingName, quantity: quantity, updated: nowSec() });
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

// ─── My Foods bookkeeping (mySubmissions) ──────────────────────────────────
// Never sent to /sync/* directly — purely local, survives a catalog-sync
// overwrite of the corresponding `foods` record since it lives in its own
// store. See computeMyFoodStatus() for how these rows turn into a status.

function dbGetAllMySubmissions(callback) {
  var tx = db.transaction('mySubmissions', 'readonly');
  var req = tx.objectStore('mySubmissions').getAll();
  req.onsuccess = function () { callback(req.result || []); };
  req.onerror = function () { callback([]); };
}

function dbPutMySubmission(record, callback) {
  var tx = db.transaction('mySubmissions', 'readwrite');
  tx.objectStore('mySubmissions').put(record);
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbGetMySubmission(id, callback) {
  var tx = db.transaction('mySubmissions', 'readonly');
  var req = tx.objectStore('mySubmissions').get(id);
  req.onsuccess = function () { callback(req.result || null); };
  req.onerror = function () { callback(null); };
}

function dbDeleteMySubmission(foodId, callback) {
  var tx = db.transaction('mySubmissions', 'readwrite');
  tx.objectStore('mySubmissions').delete(foodId);
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

// ─── Tombstone-based soft delete ───────────────────────────────────────────
// A hard delete leaves nothing local to report as "deleted" on the next
// sync — so once a device has ever logged in (getEverLoggedIn()), deletes
// become tombstones (deleted:true, a fresh `updated`) instead, and get
// filtered out of every display/query path (see renderDiary/
// renderSearchResults) until the next successful sync reports them and the
// eventual local purge (purgeOldTombstonesLocally) actually removes them. A
// device that's never logged in has nothing to reconcile against, so it
// keeps doing real hard deletes — a tombstone there would just be permanent
// local bloat with no purpose.

function dbSoftDeleteDiaryEntry(entry, callback) {
  var updated = {};
  Object.keys(entry).forEach(function (k) { updated[k] = entry[k]; });
  updated.deleted = true;
  updated.updated = nowSec();
  var tx = db.transaction('diary', 'readwrite');
  tx.objectStore('diary').put(updated);
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbSoftDeleteFood(foodId, callback) {
  var tx = db.transaction('foods', 'readwrite');
  var store = tx.objectStore('foods');
  var req = store.get(foodId);
  req.onsuccess = function () {
    var food = req.result;
    if (food) {
      food.deleted = true;
      food.updated = nowSec();
      store.put(food);
    }
  };
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function purgeOldTombstonesLocally(callback) {
  if (!getEverLoggedIn()) { callback(); return; }
  var cutoff = nowSec() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60;
  var remaining = 2;
  function done() { remaining--; if (remaining === 0) callback(); }

  var diaryTx = db.transaction('diary', 'readwrite');
  var diaryStore = diaryTx.objectStore('diary');
  diaryStore.getAll().onsuccess = function (ev) {
    (ev.target.result || []).forEach(function (entry) {
      if (entry.deleted && entry.updated && entry.updated < cutoff) diaryStore.delete(entry.id);
    });
  };
  diaryTx.oncomplete = done;
  diaryTx.onerror = done;

  var foodsTx = db.transaction('foods', 'readwrite');
  var foodsStore = foodsTx.objectStore('foods');
  foodsStore.getAll().onsuccess = function (ev) {
    (ev.target.result || []).forEach(function (food) {
      if (food.deleted && food.updated && food.updated < cutoff) foodsStore.delete(food.id);
    });
  };
  foodsTx.oncomplete = done;
  foodsTx.onerror = done;
}

// ─── Data sync (manifest.json + food files → IndexedDB) ──────────────────────

// Fetch failures (offline, CORS-blocked, etc.) surface to script as a generic,
// deliberately non-specific error — browsers withhold the real reason (e.g.
// "blocked by CORS policy") from JS for security reasons and only print it to
// the devtools console. On real KaiOS 3.0 hardware there's no console to read
// (ADB is locked down on those devices), so the best we can capture here is
// the HTTP status when we get one, or the browser's generic message otherwise.
function describeFetchError(err) {
  return (err && err.message) ? err.message : String(err);
}

// Uses XMLHttpRequest rather than fetch() — confirmed via the Options > Debug
// button that this device's Gecko 84 build silently omits the Origin header
// on fetch() GETs specifically (it sends it fine on fetch() POSTs), which
// breaks CORS for every GET this app makes to the data CDN with no visible
// error beyond a generic "NetworkError". XHR predates fetch() by years in
// this engine lineage and doesn't have this gap. Also reports download
// progress via xhr.onprogress, same purpose the old streaming-fetch version
// served (these food data files can be several MB).
function xhrGetJson(url, onProgress) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onprogress = function (e) {
      if (onProgress) onProgress(e.lengthComputable ? Math.min(1, e.loaded / e.total) : null);
    };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error('Invalid JSON from ' + url));
        }
      } else {
        reject(new Error('HTTP ' + xhr.status + ' fetching ' + url));
      }
    };
    xhr.onerror = function () {
      reject(new Error('XHR network error fetching ' + url));
    };
    xhr.send();
  });
}

// Credentialed POST helper for login/submit/sync — built on XMLHttpRequest
// rather than fetch(), same reasoning as xhrGetJson above: xhrGetJson only
// had to replace fetch() for GETs on this hardware, but the credentialed
// cookie flow this function serves is new, higher-stakes territory with no
// existing proof fetch()+credentials:'include' is reliable here either, so
// this errs toward the one network primitive already proven on real
// hardware rather than assuming fetch() is fine.
//
// Unlike xhrGetJson, this resolves on ANY response (even a 403 or 400) with
// {status, data, getHeader} — callers need the status code and body to
// branch on "session expired" / validation errors, not just success. It
// only rejects on a genuine transport failure (offline, DNS, etc.).
//
// No explicit Content-Type header is set, same trick postSubmitJson already
// used — keeps this a CORS-simple request (the backend's
// Access-Control-Allow-Headers is Content-Type only, so a custom one would
// trigger a preflight it can't answer).
function xhrPostJson(url, body) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.onload = function () {
      var data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { /* non-JSON body */ }
      resolve({
        status: xhr.status,
        data: data,
        getHeader: function (name) { return xhr.getResponseHeader(name); }
      });
    };
    xhr.onerror = function () {
      reject(new Error('XHR network error posting to ' + url));
    };
    xhr.send(JSON.stringify(body || {}));
  });
}

// ─── manifest.json check throttling ──────────────────────────────────────
//
// The food database only ever changes on Monday nights (the maintainer's
// own update cadence) — hitting manifest.json on every single boot to
// discover that nothing changed is wasted network/battery on a feature
// phone. Instead: always check if the local DB has never been synced
// (first launch, or after Clear Local DB); otherwise, only check again
// once we've crossed the most recent Tuesday-8am boundary since our last
// check — giving a buffer after the Monday-night update instead of racing
// it, while still checking at most once a week the rest of the time.

var MANIFEST_CHECK_KEY = 'lastManifestCheckAt';

function getLastManifestCheck() {
  try {
    var raw = localStorage.getItem(MANIFEST_CHECK_KEY);
    return raw ? parseInt(raw, 10) : 0;
  } catch (e) { return 0; }
}

function setLastManifestCheck(timestamp) {
  try { localStorage.setItem(MANIFEST_CHECK_KEY, String(timestamp)); } catch (e) { /* ignore */ }
}

// The most recent Tuesday 8am (local time) at or before `now`. Passing
// `now` explicitly (rather than reading `new Date()` internally) keeps
// this a pure, easily-testable function.
function mostRecentTuesday8am(now) {
  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0, 0);
  var daysSinceTuesday = (d.getDay() - 2 + 7) % 7; // getDay(): 0=Sun, 2=Tue
  d.setDate(d.getDate() - daysSinceTuesday);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7); // it's Tuesday but before 8am
  return d.getTime();
}

function shouldCheckManifest(hasAnySyncedFiles, now) {
  if (!hasAnySyncedFiles) return true; // never synced, or DB was cleared — must bootstrap
  return getLastManifestCheck() < mostRecentTuesday8am(now);
}

// onFileStart(index, total, fileEntry) fires once per file, before it starts downloading.
// onFileProgress(fraction) fires repeatedly while the current file streams in (fraction is
// null if the server didn't send a Content-Length to compute a fraction from).
function syncData(onFileStart, onFileProgress, callback) {
  dbGetSyncedFileIds(function (syncedIds) {
    if (!shouldCheckManifest(syncedIds.length > 0, new Date())) {
      callback();
      return;
    }
    xhrGetJson(DATA_HOST + '/manifest.json')
      .then(function (manifest) {
        setLastManifestCheck(Date.now());
        var toFetch = (manifest.files || []).filter(function (f) {
          return syncedIds.indexOf(f.id) === -1;
        });
        if (!toFetch.length) { setLastSyncError(null); callback(); return; }
        fetchNext(0);
        function fetchNext(i) {
          if (i >= toFetch.length) { setLastSyncError(null); callback(); return; }
          var fileEntry = toFetch[i];
          onFileStart(i + 1, toFetch.length, fileEntry);
          xhrGetJson(DATA_HOST + fileEntry.url, onFileProgress)
            .then(function (foodsArr) {
              // Tagged as 'catalog' here — this is the one place a food ever
              // becomes an "Approved" My Foods entry (see
              // computeMyFoodStatus), since a user-submitted food only ever
              // reaches this path once it's been approved+exported and
              // shows up in a downloaded manifest data file under its
              // original id.
              var tagged = foodsArr.map(function (f) {
                f.source = 'catalog';
                f.updated = nowSec();
                f.deleted = false;
                return f;
              });
              dbBulkPutFoods(tagged, function () {
                dbMarkFileSynced(fileEntry.id, function () { fetchNext(i + 1); });
              });
            })
            .catch(function (err) {
              setLastSyncError(fileEntry.url + ': ' + describeFetchError(err));
              fetchNext(i + 1);
            });
        }
      })
      .catch(function (err) {
        setLastSyncError('manifest.json: ' + describeFetchError(err));
        callback();
      }); // offline-first: fall back to whatever's already cached
  });
}

// ─── Account sync (foods / diary / preferences) ────────────────────────────
//
// Mirrors the backend's own reconciliation model: every call re-sends the
// FULL current local state of one collection (not a delta/queue), the
// server merges it against whatever it already has (newer `updated`
// timestamp wins, whole item as a unit) and returns the merged result,
// which becomes the new local source of truth. Because every call is a full
// resync rather than a queued delta, a failed call loses nothing durably —
// the next natural trigger (next mutation, next boot, next login) just
// resends the same data — so failures here are handled the same
// silent/best-effort/no-retry way /submit already was, just still recorded
// via the existing setLastSyncError() for visibility in Options.

function handleAuthExpired() {
  // A 403 from an authenticated call means the server has already
  // invalidated this session (expired, or a CSRF mismatch — see
  // authenticate_user in the backend, which deletes the token on
  // mismatch) — clear local session state to match rather than silently
  // keep sending a token the server will never accept again.
  if (!isLoggedIn()) return;
  clearCsrf();
  setAuthDotState();
}

function upsertStateFood(food) {
  state.foodsById[food.id] = food;
  var idx = -1;
  for (var i = 0; i < state.allFoods.length; i++) {
    if (state.allFoods[i].id === food.id) { idx = i; break; }
  }
  if (idx === -1) state.allFoods.push(food); else state.allFoods[idx] = food;
}

function buildFoodsSyncPayload(callback) {
  dbGetAllMySubmissions(function (subs) {
    if (!subs.length) { callback({}); return; }
    var payload = {};
    var remaining = subs.length;
    subs.forEach(function (sub) {
      dbGetFood(sub.id, function (food) {
        if (food) {
          payload[sub.id] = {
            name: food.name,
            servings: food.servings,
            updated: food.updated || nowSec(),
            deleted: food.deleted === true
          };
        }
        remaining--;
        if (remaining === 0) callback(payload);
      });
    });
  });
}

// `merged` is {foodId: {name, servings, updated, deleted}}. If a food is
// already known locally as a real catalog entry (source:'catalog' — i.e. it
// was already approved+exported and downloaded via the normal manifest
// sync), that status wins and is never demoted back to 'local' by this
// merge, even though this same id is also present in the account's own
// synced-foods collection server-side.
function applyFoodsSyncMerge(merged, callback) {
  var ids = Object.keys(merged);
  if (!ids.length) { callback(); return; }
  var remaining = ids.length;
  ids.forEach(function (id) {
    var item = merged[id];
    dbGetFood(id, function (existing) {
      var isCatalog = existing && existing.source === 'catalog';
      var food = {
        id: id,
        name: item.name,
        servings: item.servings,
        updated: item.updated,
        deleted: !!item.deleted,
        source: isCatalog ? 'catalog' : 'local'
      };
      dbBulkPutFoods([food], function () {
        upsertStateFood(food);
        remaining--;
        if (remaining === 0) callback();
      });
    });
  });
}

// Closes a cross-device gap: if a food was created on device A, device B
// (same account, different device) has no local mySubmissions row for it at
// all after logging in — without this, it would sync into device B's
// `foods` store but never show up in device B's My Foods list. `submittedAt`
// here is only an approximation (device B was never told the true original
// submission time) — the very next status check still resolves correctly
// against the catalog regardless.
function reconcileMySubmissionsFromFoodsSync(merged, callback) {
  var ids = Object.keys(merged).filter(function (id) { return merged[id].deleted !== true; });
  if (!ids.length) { callback(); return; }
  dbGetAllMySubmissions(function (subs) {
    var known = {};
    subs.forEach(function (s) { known[s.id] = true; });
    var missing = ids.filter(function (id) { return !known[id]; });
    if (!missing.length) { callback(); return; }
    var remaining = missing.length;
    missing.forEach(function (id) {
      var approxTime = merged[id].updated || nowSec();
      dbPutMySubmission({ id: id, createdAt: approxTime, submittedAt: approxTime, submitStatus: 'pending' }, function () {
        remaining--;
        if (remaining === 0) callback();
      });
    });
  });
}

function syncFoods(callback) {
  callback = callback || function () {};
  if (!isLoggedIn()) { callback(); return; }
  buildFoodsSyncPayload(function (payload) {
    xhrPostJson(SYNC_FOODS_URL, { csrf: getCsrf(), foods: payload })
      .then(function (res) {
        if (res.status === 200 && res.data && res.data.foods) {
          applyFoodsSyncMerge(res.data.foods, function () {
            reconcileMySubmissionsFromFoodsSync(res.data.foods, callback);
          });
        } else if (res.status === 403) {
          handleAuthExpired();
          callback();
        } else {
          setLastSyncError('sync/foods: HTTP ' + res.status);
          callback();
        }
      })
      .catch(function (err) {
        setLastSyncError('sync/foods: ' + describeFetchError(err));
        callback();
      });
  });
}

function buildDiarySyncPayload(date, callback) {
  dbGetDiaryByDate(date, function (rawEntries) {
    var payload = {};
    rawEntries.forEach(function (entry) {
      if (!entry.guid) return; // shouldn't happen post-migration, but don't send an unkeyable entry
      var item = {};
      Object.keys(entry).forEach(function (k) {
        if (k === 'id') return; // local autoincrement key — never sent, guid is the sync key
        item[k] = entry[k];
      });
      item.updated = entry.updated || nowSec();
      item.deleted = entry.deleted === true;
      payload[entry.guid] = item;
    });
    callback(payload);
  });
}

// `merged` is {guid: {...diary fields, updated, deleted}} for exactly one
// date. An incoming guid matching an existing local entry updates it
// in-place (preserving the local autoincrement id); an unrecognized guid is
// a new entry from another device and gets a fresh local id via add().
function applyDiarySyncMerge(date, merged, callback) {
  var guids = Object.keys(merged);
  if (!guids.length) { callback(); return; }
  dbGetDiaryByDate(date, function (rawEntries) {
    var existingByGuid = {};
    rawEntries.forEach(function (e) { if (e.guid) existingByGuid[e.guid] = e; });
    var remaining = guids.length;
    function done() { remaining--; if (remaining === 0) callback(); }
    guids.forEach(function (guid) {
      var item = merged[guid];
      var existing = existingByGuid[guid];
      var entry = {};
      Object.keys(item).forEach(function (k) { entry[k] = item[k]; });
      entry.guid = guid;
      entry.date = date;
      if (existing) {
        dbUpdateDiaryEntry(existing.id, entry, done);
      } else {
        dbAddDiaryEntry(entry, function () { done(); });
      }
    });
  });
}

function syncDiaryForDate(date, callback) {
  callback = callback || function () {};
  if (!isLoggedIn()) { callback(); return; }
  buildDiarySyncPayload(date, function (payload) {
    xhrPostJson(SYNC_DIARY_URL, { csrf: getCsrf(), date: date, entries: payload })
      .then(function (res) {
        if (res.status === 200 && res.data && res.data.entries) {
          applyDiarySyncMerge(date, res.data.entries, function () {
            if (date === state.currentDate) renderDiary(); // pick up anything another device added
            callback();
          });
        } else if (res.status === 403) {
          handleAuthExpired();
          callback();
        } else {
          setLastSyncError('sync/diary: HTTP ' + res.status);
          callback();
        }
      })
      .catch(function (err) {
        setLastSyncError('sync/diary: ' + describeFetchError(err));
        callback();
      });
  });
}

function applyPreferencesSyncMerge(merged, callback) {
  if (merged.settings && typeof merged.settings.showCaffeine === 'boolean') {
    try { localStorage.setItem('showCaffeine', String(merged.settings.showCaffeine)); } catch (e) { /* ignore */ }
    if (merged.settings.updated) setShowCaffeineUpdatedAt(merged.settings.updated);
    applyCaffeineVisibility();
  }
  var lastServings = merged.lastServings || {};
  var usageCounts = merged.usageCounts || {};
  var lsIds = Object.keys(lastServings);
  var ucIds = Object.keys(usageCounts);
  var remaining = lsIds.length + ucIds.length;
  if (remaining === 0) { callback(); return; }
  function done() { remaining--; if (remaining === 0) callback(); }
  lsIds.forEach(function (foodId) {
    var r = lastServings[foodId];
    state.lastServings[foodId] = { servingName: r.servingName, quantity: r.quantity };
    var tx = db.transaction('lastServings', 'readwrite');
    tx.objectStore('lastServings').put({ id: foodId, servingName: r.servingName, quantity: r.quantity, updated: r.updated });
    tx.oncomplete = done;
    tx.onerror = done;
  });
  ucIds.forEach(function (foodId) {
    var r = usageCounts[foodId];
    state.usageCounts[foodId] = r.count;
    var tx = db.transaction('usageCounts', 'readwrite');
    tx.objectStore('usageCounts').put({ id: foodId, count: r.count, updated: r.updated });
    tx.oncomplete = done;
    tx.onerror = done;
  });
}

function syncPreferences(callback) {
  callback = callback || function () {};
  if (!isLoggedIn()) { callback(); return; }
  dbGetAllLastServings(function (lastServingRecords) {
    dbGetAllUsageCounts(function (usageRecords) {
      var lastServings = {};
      lastServingRecords.forEach(function (r) {
        lastServings[r.id] = { servingName: r.servingName, quantity: r.quantity, updated: r.updated || nowSec() };
      });
      var usageCounts = {};
      usageRecords.forEach(function (r) {
        usageCounts[r.id] = { count: r.count, updated: r.updated || nowSec() };
      });
      var body = {
        csrf: getCsrf(),
        settings: { showCaffeine: getShowCaffeine(), updated: getShowCaffeineUpdatedAt() || nowSec() },
        lastServings: lastServings,
        usageCounts: usageCounts
      };
      xhrPostJson(SYNC_PREFERENCES_URL, body)
        .then(function (res) {
          if (res.status === 200 && res.data) {
            applyPreferencesSyncMerge(res.data, callback);
          } else if (res.status === 403) {
            handleAuthExpired();
            callback();
          } else {
            setLastSyncError('sync/preferences: HTTP ' + res.status);
            callback();
          }
        })
        .catch(function (err) {
          setLastSyncError('sync/preferences: ' + describeFetchError(err));
          callback();
        });
    });
  });
}

// Called after any diary add/edit/delete — a no-op while logged out.
function syncAfterDiaryMutation() {
  if (!isLoggedIn()) return;
  syncDiaryForDate(state.currentDate);
  syncPreferences();
}

function runFullSync(callback) {
  callback = callback || function () {};
  if (!isLoggedIn()) { callback(); return; }
  syncFoods(function () {
    syncDiaryForDate(state.currentDate, function () {
      syncPreferences(callback);
    });
  });
}

// Keeps the session alive across long-lived, actively-used installs without
// waiting on its own 4-month expiration — throttled to roughly once/day,
// mirroring kaios-shared-list's refreshCookieIfNeeded.
var ACCOUNT_REFRESH_KEY = 'accountRefreshAt';

function accountRefreshIfNeeded() {
  if (!isLoggedIn()) return;
  var last = 0;
  try { last = parseInt(localStorage.getItem(ACCOUNT_REFRESH_KEY), 10) || 0; } catch (e) { /* ignore */ }
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  xhrPostJson(ACCOUNT_REFRESH_URL, { csrf: getCsrf() })
    .then(function (res) {
      if (res.status === 200) {
        try { localStorage.setItem(ACCOUNT_REFRESH_KEY, String(Date.now())); } catch (e) { /* ignore */ }
      } else if (res.status === 403) {
        handleAuthExpired();
      }
    })
    .catch(function () { /* best-effort — next boot tries again */ });
}

// ─── Panel & Softkey ──────────────────────────────────────────────────────────

function showPanel(id) {
  var panels = document.querySelectorAll('.panel');
  for (var i = 0; i < panels.length; i++) {
    panels[i].setAttribute('active', 'false');
  }
  var panel = document.getElementById(id);
  panel.setAttribute('active', 'true');
  window.scrollTo(0, 0);
  var first = panel.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function setSoftkeys(left, center, right) {
  document.getElementById('sk-left').textContent = left;
  document.getElementById('sk-center').textContent = center;
  document.getElementById('sk-right').textContent = right;
}

function updateSoftkeysForFocus() {
  if (isSheetOpen()) return; // openSheet()/closeSheet() own the softkeys while it's up
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-diary') {
    var focusedEl = focused();
    var onAddFood = focusedEl && focusedEl.id === 'btn-diary-add-food';
    setSoftkeys('', onAddFood ? 'Add' : 'Edit', 'Options');
  } else if (panel.id === 'panel-search') {
    var label = state.tray.length ? ('Add (' + (state.tray.length + 1) + ')') : 'Add';
    setSoftkeys('Back', label, 'Tray');
  } else if (panel.id === 'panel-servings') {
    setSoftkeys('Back', 'Save', 'Delete');
  } else if (panel.id === 'panel-new-food') {
    var onSubmitBtn = focused() && focused().id === 'btn-new-food-submit';
    setSoftkeys('Back', onSubmitBtn ? 'Submit' : 'Next', '');
  } else if (panel.id === 'panel-options') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-login-email') {
    setSoftkeys('Back', 'Next', '');
  } else if (panel.id === 'panel-login-otp') {
    setSoftkeys('Back', 'Verify', '');
  } else if (panel.id === 'panel-my-foods') {
    setSoftkeys('Back', 'SELECT', '');
  }
}

// ─── D-pad Navigation ─────────────────────────────────────────────────────────

function activePanel() {
  return document.querySelector('.panel[active="true"]');
}

function selectables() {
  if (isSheetOpen()) {
    return Array.prototype.slice.call(document.querySelectorAll('#sheet [nav-selectable="true"]'));
  }
  var panel = activePanel();
  if (!panel) return [];
  return Array.prototype.slice.call(panel.querySelectorAll('[nav-selectable="true"]'));
}

function focused() {
  return document.querySelector('[nav-selected="true"]');
}

var SOFTKEY_H = 30;

function setFocus(el) {
  if (!el) return;
  var prev = focused();
  if (prev) prev.removeAttribute('nav-selected');
  el.setAttribute('nav-selected', 'true');
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  el.focus();
  scrollToVisible(el);
  updateSoftkeysForFocus();
}

function scrollToVisible(el) {
  var elRect = el.getBoundingClientRect();
  var firstNavEl = document.querySelector('.panel[active="true"] [nav-selectable="true"]');
  if (el === firstNavEl) {
    window.scrollTo(0, 0);
    return;
  }
  if (elRect.bottom + SOFTKEY_H > window.innerHeight) {
    window.scrollBy(0, elRect.bottom + SOFTKEY_H - window.innerHeight);
  } else if (elRect.top < 0) {
    window.scrollBy(0, elRect.top);
  }
}

function moveFocus(dir) {
  var els = selectables();
  if (!els.length) return;
  var cur = focused();
  var idx = els.indexOf(cur);
  var next;
  if (dir === 'down') {
    next = (idx >= 0 && idx < els.length - 1) ? els[idx + 1] : els[0];
  } else {
    next = (idx > 0) ? els[idx - 1] : els[els.length - 1];
  }
  setFocus(next);
}

function interact(el) {
  if (el) el.click();
}

function isTextInput(el) {
  // Excludes type="file": it has no text-editing/cursor semantics, and
  // pressing Enter/center on it should fall through to interact() → .click()
  // to open the native file chooser, not be suppressed like a text field.
  return el && ((el.tagName === 'INPUT' && el.type !== 'file') || el.tagName === 'TEXTAREA');
}

// Some native controls (date inputs, <select>) pop their own full-UI picker
// the instant they receive focus — fine for a deliberate tap/click, but
// wrong for D-pad navigation, where just landing on a field while scrolling
// through the panel would otherwise yank up a date picker or dropdown
// nobody asked to open yet. For these, nav-selectable lives on the
// surrounding .input-wrap div instead (just a halo, no native picker), and
// this forwards the actual "open it" action to the real control — wired to
// the wrapper's 'click' event, which already fires from the generic
// non-text-input Enter/center path (interact() → el.click()), so no
// keydown-handling changes are needed.
function wireFocusForwardingWrapper(wrapperId, innerId) {
  var inner = document.getElementById(innerId);
  document.getElementById(wrapperId).addEventListener('click', function () {
    inner.focus();
  });
}

// ─── Bottom Sheet ─────────────────────────────────────────────────────────────

var _sheetSavedSoftkeys = ['', '', ''];
var _sheetSavedFocus = null;

function isSheetOpen() {
  return document.getElementById('sheet').getAttribute('active') === 'true';
}

function openSheet(items, header) {
  _sheetSavedFocus = focused();

  var sheetHeader = document.getElementById('sheet-header');
  if (header) {
    document.getElementById('sheet-title').textContent = header.title;
    document.getElementById('sheet-note').textContent = header.note;
    sheetHeader.setAttribute('active', 'true');
  } else {
    sheetHeader.setAttribute('active', 'false');
  }

  var ul = document.getElementById('sheet-ul');
  ul.innerHTML = '';
  items.forEach(function (item) {
    var li = document.createElement('li');
    li.className = 'list-row' + (item.danger ? ' danger' : '');
    li.setAttribute('nav-selectable', 'true');
    li.textContent = item.label;
    li.addEventListener('click', item.action);
    ul.appendChild(li);
  });
  _sheetSavedSoftkeys = [
    document.getElementById('sk-left').textContent,
    document.getElementById('sk-center').textContent,
    document.getElementById('sk-right').textContent
  ];
  var sheetEl = document.getElementById('sheet');
  sheetEl.setAttribute('active', 'true');
  document.getElementById('sheet-overlay').setAttribute('active', 'true');
  setSoftkeys('Back', 'SELECT', '');
  var first = ul.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
  // setFocus()'s el.focus() call above triggers the browser's native
  // scroll-into-view for the focused row — since that's usually the single
  // "Dismiss" button sitting after a long note, it jumps straight to the
  // bottom and hides the start of the message. Force it back to the top so
  // long content (error text, debug dumps) is readable from the beginning.
  sheetEl.scrollTop = 0;
}

function closeSheet() {
  document.getElementById('sheet').setAttribute('active', 'false');
  document.getElementById('sheet-overlay').setAttribute('active', 'false');
  document.getElementById('sheet-ul').innerHTML = '';
  setSoftkeys(_sheetSavedSoftkeys[0], _sheetSavedSoftkeys[1], _sheetSavedSoftkeys[2]);
  var restore = _sheetSavedFocus;
  _sheetSavedFocus = null;
  if (!restore) {
    var panel = activePanel();
    if (panel) restore = panel.querySelector('[nav-selectable="true"]');
  }
  if (restore) setFocus(restore);
}

// ─── Key Handling ─────────────────────────────────────────────────────────────

document.addEventListener('mousedown', function () {
  document.body.classList.remove('using-keyboard');
}, true);

document.addEventListener('touchstart', function () {
  document.body.classList.remove('using-keyboard');
}, { passive: true, capture: true });

document.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    document.body.classList.add('using-keyboard');
  }
  if (isSheetOpen()) {
    // Sheets often show more content (long error/debug text) than fits in
    // the visible area, but may only have one or two selectable rows (e.g.
    // a single "Dismiss" button) — moveFocus() alone wouldn't let the D-pad
    // reveal the rest, so up/down also nudge the sheet's own scroll position.
    var SHEET_SCROLL_STEP = 48;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        moveFocus('up');
        document.getElementById('sheet').scrollBy(0, -SHEET_SCROLL_STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus('down');
        document.getElementById('sheet').scrollBy(0, SHEET_SCROLL_STEP);
        break;
      case 'Enter':     e.preventDefault(); interact(focused()); break;
      case 'SoftLeft':
      case 'Backspace': e.preventDefault(); closeSheet(); break;
    }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (isTextInput(document.activeElement)) {
        var elUp = document.activeElement;
        try {
          if (elUp.selectionStart === 0 && elUp.selectionEnd === 0) {
            moveFocus('up');
          } else {
            elUp.setSelectionRange(0, 0);
          }
        } catch (_e) { moveFocus('up'); }
      } else {
        moveFocus('up');
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (isTextInput(document.activeElement)) {
        var elDown = document.activeElement;
        try {
          var len = elDown.value.length;
          if (elDown.selectionStart === len && elDown.selectionEnd === len) {
            moveFocus('down');
          } else {
            elDown.setSelectionRange(len, len);
          }
        } catch (_e) { moveFocus('down'); }
      } else {
        moveFocus('down');
      }
      break;
    case 'Enter':
      if (!isTextInput(document.activeElement)) {
        e.preventDefault();
        interact(focused());
      }
      break;
    case 'SoftLeft':
      e.preventDefault();
      handleSoftLeft();
      break;
    case 'SoftRight':
      e.preventDefault();
      handleSoftRight();
      break;
    case 'Backspace':
      if (!isTextInput(document.activeElement)) {
        var bp = activePanel();
        if (bp && bp.id !== 'panel-diary') {
          e.preventDefault();
          handleSoftLeft();
        }
        // else: no preventDefault — OS handles back gesture to exit app
      }
      break;
  }
});

function handleSoftLeft() {
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-search') {
    state.tray = [];
    showDiaryPanel();
  } else if (panel.id === 'panel-servings') {
    showDiaryPanel();
  } else if (panel.id === 'panel-new-food') {
    returnToSearchPanel();
  } else if (panel.id === 'panel-options') {
    showDiaryPanel();
  } else if (panel.id === 'panel-login-email') {
    showOptionsPanel();
  } else if (panel.id === 'panel-login-otp') {
    showLoginEmailPanel();
  } else if (panel.id === 'panel-my-foods') {
    showOptionsPanel();
  }
  // panel-diary: no left-softkey action
}

function handleSoftRight() {
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-diary') {
    showOptionsPanel();
  } else if (panel.id === 'panel-search') {
    addFocusedToTray();
  } else if (panel.id === 'panel-servings') {
    deleteCurrentEntry();
  }
  // panel-options: no right-softkey action
}

document.getElementById('sk-left').addEventListener('click', function () {
  if (isSheetOpen()) { closeSheet(); } else { handleSoftLeft(); }
});
document.getElementById('sk-right').addEventListener('click', handleSoftRight);
document.getElementById('sk-center').addEventListener('click', function () {
  if (isSheetOpen()) { interact(focused()); return; }
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-search') {
    var food = getFocusedFood();
    if (food) commitFoodAndTray(food);
    else showStatus('Select a food first', true);
  } else if (panel.id === 'panel-servings') {
    saveServingsEdit();
  } else if (panel.id === 'panel-new-food') {
    newFoodCenterAction();
  } else if (panel.id === 'panel-login-email') {
    submitLoginEmail();
  } else if (panel.id === 'panel-login-otp') {
    submitLoginOtp();
  } else {
    interact(focused());
  }
});
document.getElementById('sheet-overlay').addEventListener('click', closeSheet);

// ─── Screen: Diary ────────────────────────────────────────────────────────────

function showDiaryPanel() {
  document.getElementById('input-diary-date').value = state.currentDate;
  // Build the diary list first, THEN show the panel — showPanel() auto-focuses
  // the first nav-selectable element it finds, and if that ran before the DOM
  // reflects the current date's entries, focus could land on the date input
  // at the bottom instead of "+ Add Food" / the first row.
  renderDiary(function () {
    showPanel('panel-diary');
  });
}

document.getElementById('btn-diary-add-food').addEventListener('click', showSearchPanel);

document.getElementById('input-diary-date').addEventListener('change', function (e) {
  state.currentDate = e.target.value || todayStr();
  renderDiary(); // already on this panel — don't re-show/re-focus, just refresh the list
  syncDiaryForDate(state.currentDate);
});

wireFocusForwardingWrapper('wrap-diary-date', 'input-diary-date');

function renderDiary(callback) {
  dbGetDiaryByDate(state.currentDate, function (rawEntries) {
    // Tombstoned entries stay in IndexedDB (see dbSoftDeleteDiaryEntry) so a
    // later sync can report the deletion — they're just never shown.
    var entries = rawEntries.filter(function (e) { return e.deleted !== true; });
    state.diaryEntries = entries;
    var ul = document.getElementById('diary-ul');
    ul.innerHTML = '';
    document.getElementById('diary-empty').style.display = entries.length ? 'none' : 'block';

    entries.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'food-row';
      li.setAttribute('nav-selectable', 'true');
      li.setAttribute('data-entry-id', entry.id);

      var name = document.createElement('span');
      name.className = 'food-row-name';
      name.textContent = entry.foodName;

      var serving = document.createElement('span');
      serving.className = 'food-row-serving';
      serving.textContent = formatQty(entry.quantity) + ' ' + entry.servingName;

      var cal = document.createElement('span');
      cal.className = 'food-row-calories';
      cal.textContent = Math.round(entry.calories || 0);

      li.appendChild(name);
      li.appendChild(serving);
      li.appendChild(cal);
      li.addEventListener('click', function () { showServingsPanel(entry); });
      ul.appendChild(li);
    });

    renderDiarySummary(entries);
    if (callback) callback();
  });
}

function renderDiarySummary(entries) {
  var totals = {};
  SUMMARY_KEYS.forEach(function (k) { totals[k] = 0; });
  entries.forEach(function (e) {
    SUMMARY_KEYS.forEach(function (k) { totals[k] += (e[k] || 0); });
  });
  SUMMARY_KEYS.forEach(function (k) {
    document.getElementById('sum-' + k).textContent = Math.round(totals[k]);
  });
}

// ─── Screen: Search ───────────────────────────────────────────────────────────

function showSearchPanel() {
  state.tray = [];
  showPanel('panel-search');
  document.getElementById('input-search').value = '';
  renderSearchResults('');
  setSoftkeys('Back', 'Add', 'Tray');
}

// Returning from New Food's Back action — unlike showSearchPanel(), this
// preserves whatever query/results/tray the user already had going.
function returnToSearchPanel() {
  showPanel('panel-search');
}

var _searchDebounce = null;
document.getElementById('input-search').addEventListener('input', function (e) {
  var q = e.target.value;
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(function () { renderSearchResults(q); }, 150);
});

function renderSearchResults(query) {
  var ul = document.getElementById('search-ul');
  ul.innerHTML = '';
  var q = query.trim().toLowerCase();
  var results = q ? state.allFoods.filter(function (f) {
    return f.deleted !== true && f.name.toLowerCase().indexOf(q) !== -1;
  }).sort(function (a, b) {
    var countA = state.usageCounts[a.id] || 0;
    var countB = state.usageCounts[b.id] || 0;
    if (countB !== countA) return countB - countA; // most-used first
    return a.name.localeCompare(b.name);            // then alphabetical
  }).slice(0, 50) : [];

  results.forEach(function (food) {
    var li = document.createElement('li');
    li.className = 'search-row' + (trayHasFood(food.id) ? ' in-tray' : '');
    li.setAttribute('nav-selectable', 'true');
    li.setAttribute('data-food-id', food.id);
    li.textContent = food.name;
    li.addEventListener('click', function () { commitFoodAndTray(food); });
    ul.appendChild(li);
  });

  // Always the last row for any non-empty query — whether there are 0 or 50
  // real matches above it.
  if (q) {
    var addNew = document.createElement('li');
    addNew.className = 'search-row add-new';
    addNew.setAttribute('nav-selectable', 'true');
    addNew.textContent = '+ Add new food';
    addNew.addEventListener('click', function () { showNewFoodPanel(query.trim()); });
    ul.appendChild(addNew);
  }
}

function trayHasFood(id) {
  return state.tray.some(function (f) { return f.id === id; });
}

function getFocusedFood() {
  var el = focused();
  var id = el && el.getAttribute && el.getAttribute('data-food-id');
  return id ? state.foodsById[id] : null;
}

function addFocusedToTray() {
  var el = focused();
  var food = getFocusedFood();
  if (!food) return;
  state.tray.push(food);
  el.classList.add('in-tray');
  updateSoftkeysForFocus();
  showStatus('Added to tray (' + state.tray.length + ')', false);
}

// Defaults to whatever serving+quantity was last used for this specific
// food (see rememberServing), falling back to the food's own base serving
// ('g', or its first serving) the first time a food is ever added.
function defaultServingForFood(food) {
  var last = state.lastServings[food.id];
  if (last) {
    var match = food.servings.filter(function (s) { return s.name === last.servingName; })[0];
    if (match) return { serving: match, quantity: last.quantity };
  }
  var base = food.servings.filter(function (s) { return s.name === 'g'; })[0] || food.servings[0];
  return { serving: base, quantity: base.quantity };
}

function rememberServing(foodId, servingName, quantity, callback) {
  state.lastServings[foodId] = { servingName: servingName, quantity: quantity };
  dbSetLastServing(foodId, servingName, quantity, callback);
}

function addFoodToDiaryDefault(food, callback) {
  var def = defaultServingForFood(food);
  var entry = buildDiaryEntry(food, def.serving, def.quantity);
  dbAddDiaryEntry(entry, function (newId) {
    state.usageCounts[food.id] = (state.usageCounts[food.id] || 0) + 1;
    dbIncrementUsageCount(food.id, function () {
      rememberServing(food.id, def.serving.name, def.quantity, function () {
        if (callback) callback(newId);
      });
    });
  });
}

function commitFoodAndTray(food) {
  var items = state.tray.concat([food]);
  state.tray = [];
  var remaining = items.length;
  items.forEach(function (f) {
    addFoodToDiaryDefault(f, function () {
      remaining--;
      if (remaining === 0) {
        showDiaryPanel();
        showStatus('Added ' + items.length + (items.length === 1 ? ' item' : ' items'), false);
        syncAfterDiaryMutation();
      }
    });
  });
}

// ─── Serving math ─────────────────────────────────────────────────────────────

function buildDiaryEntry(food, servingObj, qty) {
  var scale = servingObj.quantity ? (qty / servingObj.quantity) : 0;
  var entry = {
    date: state.currentDate,
    foodId: food.id,
    foodName: food.name,
    servingName: servingObj.name,
    quantity: qty,
    // Stable cross-device id for /sync/diary's merge key — distinct from
    // the local autoincrement `id`, which stays purely a local IndexedDB
    // key (see the v4 DB migration). Callers editing an existing entry
    // should overwrite this with the entry's original guid afterward.
    guid: generateGuid(),
    updated: nowSec(),
    deleted: false
  };
  Object.keys(servingObj).forEach(function (key) {
    if (key === 'name' || key === 'quantity') return;
    entry[key] = round2(servingObj[key] * scale);
  });
  return entry;
}

// ─── Screen: Servings ─────────────────────────────────────────────────────────

function showServingsPanel(entry) {
  state.editingEntry = entry;
  state.editingFood = state.foodsById[entry.foodId] || null;

  showPanel('panel-servings');
  document.getElementById('servings-food-name').textContent = entry.foodName;
  document.getElementById('input-serving-qty').value = formatQty(entry.quantity);

  var select = document.getElementById('input-serving-name');
  select.innerHTML = '';
  var servingOptions = state.editingFood ? state.editingFood.servings : [{ name: entry.servingName, quantity: entry.quantity }];
  servingOptions.forEach(function (s) {
    var opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    if (s.name === entry.servingName) opt.selected = true;
    select.appendChild(opt);
  });

  renderServingsPreview();
  setSoftkeys('Back', 'Save', 'Delete');
}

function currentServingBaseline() {
  if (!state.editingFood) return null;
  var name = document.getElementById('input-serving-name').value;
  return state.editingFood.servings.filter(function (s) { return s.name === name; })[0] || null;
}

function renderServingsPreview() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  var values;
  if (baseline) {
    values = {};
    var scale = baseline.quantity ? (qty / baseline.quantity) : 0;
    Object.keys(baseline).forEach(function (key) {
      if (key === 'name' || key === 'quantity') return;
      values[key] = baseline[key] * scale;
    });
  } else {
    values = state.editingEntry || {};
  }
  SUMMARY_KEYS.forEach(function (k) {
    var el = document.getElementById('serv-' + k);
    if (el) el.textContent = Math.round(values[k] || 0);
  });
  renderServingsNutrients(values);
}

function renderServingsNutrients(values) {
  var container = document.getElementById('servings-nutrients');
  container.innerHTML = '';
  Object.keys(values).forEach(function (key) {
    if (NON_NUTRIENT_KEYS.indexOf(key) !== -1) return;
    if (SUMMARY_KEYS.indexOf(key) !== -1) return;
    var row = document.createElement('div');
    row.className = 'nutrient-row';
    var label = document.createElement('span');
    label.className = 'nutrient-label';
    label.textContent = humanizeKey(key);
    var val = document.createElement('span');
    val.className = 'nutrient-value';
    val.textContent = round2(values[key]);
    row.appendChild(label);
    row.appendChild(val);
    container.appendChild(row);
  });
}

// Exact behavior requested: every keystroke, replace any non-digit character
// with '.', then collapse everything after the first '.' to strip extra dots.
function sanitizeQtyInput(el) {
  var raw = el.value;
  var replaced = raw.replace(/\D/g, '.');
  var firstDot = replaced.indexOf('.');
  var cleaned = replaced;
  if (firstDot !== -1) {
    cleaned = replaced.slice(0, firstDot + 1) + replaced.slice(firstDot + 1).replace(/\./g, '');
  }
  if (cleaned !== raw) {
    el.value = cleaned;
    try { el.setSelectionRange(cleaned.length, cleaned.length); } catch (_e) {}
  }
}

document.getElementById('input-serving-qty').addEventListener('input', function (e) {
  sanitizeQtyInput(e.target);
  renderServingsPreview();
});

document.getElementById('input-serving-qty').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveServingsEdit();
  }
});

document.getElementById('input-serving-name').addEventListener('change', renderServingsPreview);

wireFocusForwardingWrapper('wrap-serving-name', 'input-serving-name');

function saveServingsEdit() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  if (!baseline) {
    showStatus('Could not save (food data unavailable)', true);
    return;
  }
  var updated = buildDiaryEntry(state.editingFood, baseline, qty);
  // Preserve the entry's original guid across an edit — it's the /sync/diary
  // merge key, and a fresh one here would make the server treat this as a
  // brand new entry rather than an update to the existing one.
  updated.guid = state.editingEntry.guid || updated.guid;
  dbUpdateDiaryEntry(state.editingEntry.id, updated, function () {
    rememberServing(state.editingFood.id, baseline.name, qty, function () {
      showDiaryPanel();
      syncAfterDiaryMutation();
    });
  });
}

function deleteCurrentEntry() {
  if (!state.editingEntry) return;
  var entry = state.editingEntry;
  var foodId = entry.foodId;
  function afterDelete() {
    state.usageCounts[foodId] = Math.max(0, (state.usageCounts[foodId] || 0) - 1);
    dbDecrementUsageCount(foodId, function () {
      showDiaryPanel();
      showStatus('Deleted', false);
      syncAfterDiaryMutation();
    });
  }
  // Once this device has ever logged in, deletes become tombstones so a
  // later sync can report them — see dbSoftDeleteDiaryEntry.
  if (getEverLoggedIn()) {
    dbSoftDeleteDiaryEntry(entry, afterDelete);
  } else {
    dbDeleteDiaryEntry(entry.id, afterDelete);
  }
}

// ─── Screen: New Food ─────────────────────────────────────────────────────────

var NEW_FOOD_NUMERIC_FIELDS = [
  'input-new-food-serving-qty',
  'input-new-food-calories',
  'input-new-food-fat',
  'input-new-food-carbs',
  'input-new-food-protein'
];

// Center/Enter on this panel should step through the fields one at a time —
// only actually submitting once focus has reached the Submit button itself
// (see updateSoftkeysForFocus(), which shows "Next" until then). Shared by
// both the physical-key path (wireAdvanceOnEnter, used for both the static
// fields and any dynamically-added extra-serving fields) and the on-screen
// center softkey click handler.
function newFoodCenterAction() {
  var el = focused();
  if (el && el.id === 'btn-new-food-submit') {
    submitNewFood();
  } else if (el && !isTextInput(el)) {
    // e.g. the photo file input — center should open its native picker,
    // same as Enter already does for non-text-input elements everywhere
    // else in the app, not advance past it.
    interact(el);
  } else {
    moveFocus('down');
  }
}

function wireNumericField(el) {
  el.addEventListener('input', function (e) {
    sanitizeQtyInput(e.target);
  });
}

function wireAdvanceOnEnter(el) {
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Without this, the keydown would keep bubbling to the document-level
      // handler after newFoodCenterAction() has already moved focus — if
      // that landed on the Submit button, its "non-text-input" Enter case
      // would immediately fire too, submitting on the very keystroke that
      // was only meant to move focus onto the button.
      e.stopPropagation();
      newFoodCenterAction();
    }
  });
}

NEW_FOOD_NUMERIC_FIELDS.forEach(function (id) {
  wireNumericField(document.getElementById(id));
});

NEW_FOOD_NUMERIC_FIELDS.concat(['input-new-food-name', 'input-new-food-serving-name']).forEach(function (id) {
  wireAdvanceOnEnter(document.getElementById(id));
});

document.getElementById('btn-new-food-submit').addEventListener('click', submitNewFood);

// ─── Extra (optional) servings ────────────────────────────────────────────
//
// Lets a user-submitted custom food end up with more than one serving
// option, same as the multi-serving shape seeded foods already have (e.g.
// "Milk, Whole" has cup/fl oz/g) — the Servings panel already supports
// picking between multiple servings for a food, this just gives custom
// foods a way to define more than one. Each block is independent and, if
// left entirely blank, is silently skipped at submit time rather than
// blocking submission — clicking the button by mistake shouldn't force the
// user to fill anything in or find a "remove" control.

var extraServingCount = 0;

function addExtraServingBlock() {
  var idx = extraServingCount++;
  var wrap = document.createElement('div');
  wrap.className = 'extra-serving-block';

  var fields = [
    { cls: 'serving-qty', type: 'tel', inputmode: 'decimal', label: 'Serving size', numeric: true },
    { cls: 'serving-name', type: 'text', label: 'Serving unit (e.g. cup, slice)', numeric: false },
    { cls: 'calories', type: 'tel', inputmode: 'decimal', label: 'Calories', numeric: true },
    { cls: 'fat', type: 'tel', inputmode: 'decimal', label: 'Fat (g)', numeric: true },
    { cls: 'carbs', type: 'tel', inputmode: 'decimal', label: 'Carbs (g)', numeric: true },
    { cls: 'protein', type: 'tel', inputmode: 'decimal', label: 'Protein (g)', numeric: true }
  ];

  var title = document.createElement('span');
  title.className = 'extra-serving-title';
  title.textContent = 'Additional Serving';
  wrap.appendChild(title);

  fields.forEach(function (f) {
    var id = 'extra-serving-' + idx + '-' + f.cls;
    var inputWrap = document.createElement('div');
    inputWrap.className = 'input-wrap';

    var input = document.createElement('input');
    input.id = id;
    input.type = f.type;
    if (f.inputmode) input.setAttribute('inputmode', f.inputmode);
    input.placeholder = ' ';
    input.setAttribute('nav-selectable', 'true');
    input.className = 'extra-serving-field extra-serving-' + f.cls;
    input.setAttribute('data-extra-serving-index', idx);

    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = f.label;

    inputWrap.appendChild(input);
    inputWrap.appendChild(label);
    wrap.appendChild(inputWrap);

    if (f.numeric) wireNumericField(input);
    wireAdvanceOnEnter(input);
  });

  // Placed after the fields, not before — a D-pad nav-selectable Remove
  // button at the top of the block would be the very first thing reached
  // when tabbing down into it, one Enter press away from deleting a block
  // nobody had even looked at yet.
  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-serving-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.setAttribute('nav-selectable', 'true');
  removeBtn.addEventListener('click', function () {
    wrap.remove();
    setFocus(document.getElementById('btn-add-extra-serving'));
  });
  wrap.appendChild(removeBtn);

  document.getElementById('extra-servings-container').appendChild(wrap);
  return wrap;
}

document.getElementById('btn-add-extra-serving').addEventListener('click', function () {
  var block = addExtraServingBlock();
  setFocus(block.querySelector('[nav-selectable="true"]'));
});

// Reads back every extra-serving block currently in the DOM, skipping any
// that are entirely untouched, and validating the ones that aren't.
// Returns null (and shows an error) if a partially-filled block is missing
// a required value; otherwise an array (possibly empty) of serving objects
// in the same shape as the food's primary serving.
function collectExtraServings() {
  var blocks = document.querySelectorAll('.extra-serving-block');
  var result = [];
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var qtyEl = block.querySelector('.extra-serving-serving-qty');
    var nameEl = block.querySelector('.extra-serving-serving-name');
    var caloriesEl = block.querySelector('.extra-serving-calories');
    var qtyRaw = qtyEl.value.trim();
    var nameRaw = nameEl.value.trim();
    var caloriesRaw = caloriesEl.value.trim();

    if (!qtyRaw && !nameRaw && !caloriesRaw &&
        !block.querySelector('.extra-serving-fat').value.trim() &&
        !block.querySelector('.extra-serving-carbs').value.trim() &&
        !block.querySelector('.extra-serving-protein').value.trim()) {
      continue; // untouched block — skip silently
    }

    var qty = parseFloat(qtyRaw);
    var calories = parseFloat(caloriesRaw);
    if (!qty || !nameRaw || isNaN(calories)) {
      showStatus('Fill in size, unit, and calories for every additional serving (or leave it blank)', true);
      return null;
    }

    result.push({
      name: nameRaw,
      quantity: qty,
      calories: calories,
      fat: parseFloat(block.querySelector('.extra-serving-fat').value) || 0,
      carbohydrates: parseFloat(block.querySelector('.extra-serving-carbs').value) || 0,
      protein: parseFloat(block.querySelector('.extra-serving-protein').value) || 0
    });
  }
  return result;
}

function showNewFoodPanel(prefillName) {
  document.getElementById('input-new-food-name').value = prefillName || '';
  document.getElementById('input-new-food-serving-qty').value = '';
  document.getElementById('input-new-food-serving-name').value = '';
  document.getElementById('input-new-food-calories').value = '';
  document.getElementById('input-new-food-fat').value = '';
  document.getElementById('input-new-food-carbs').value = '';
  document.getElementById('input-new-food-protein').value = '';
  document.getElementById('input-new-food-photo').value = '';
  document.getElementById('extra-servings-container').innerHTML = '';
  extraServingCount = 0;

  // showPanel() focuses the first field and updateSoftkeysForFocus() sets
  // the correct label ("Next", not "Submit" — that only applies once focus
  // actually reaches the Submit button) — no explicit setSoftkeys() here.
  showPanel('panel-new-food');
}

function submitNewFood() {
  var name = document.getElementById('input-new-food-name').value.trim();
  var servingQty = parseFloat(document.getElementById('input-new-food-serving-qty').value);
  var servingName = document.getElementById('input-new-food-serving-name').value.trim();
  var calories = parseFloat(document.getElementById('input-new-food-calories').value);
  var fat = parseFloat(document.getElementById('input-new-food-fat').value) || 0;
  var carbs = parseFloat(document.getElementById('input-new-food-carbs').value) || 0;
  var protein = parseFloat(document.getElementById('input-new-food-protein').value) || 0;
  var photoInput = document.getElementById('input-new-food-photo');
  var photo = photoInput.files && photoInput.files[0];

  if (!name || !servingQty || !servingName || isNaN(calories)) {
    showStatus('Name, serving, and calories are required', true);
    return;
  }

  var extraServings = collectExtraServings();
  if (extraServings === null) return; // a partially-filled block failed validation

  var id = generateGuid();
  var food = {
    id: id,
    name: name,
    servings: [{
      name: servingName,
      quantity: servingQty,
      calories: calories,
      fat: fat,
      carbohydrates: carbs,
      protein: protein
    }].concat(extraServings),
    source: 'local',
    updated: nowSec(),
    deleted: false
  };

  dbBulkPutFoods([food], function () {
    state.allFoods.push(food);
    state.foodsById[food.id] = food;

    // My Foods must show every locally-created food regardless of login
    // state, so this bookkeeping row is created unconditionally — only the
    // actual submission attempt below is gated on being logged in.
    dbPutMySubmission({ id: id, createdAt: nowSec(), submittedAt: null, submitStatus: 'local' }, function () {
      addFoodToDiaryDefault(food, function () {
        if (isLoggedIn()) submitNewFoodToApi(id, name, food.servings, photo);
        showDiaryPanel();
        showStatus('Added ' + name, false);
      });
    });
  });
}

// Maps a File's declared type (falling back to its name's extension) to one
// of the extensions the backend's /presigned-post whitelists. Returns null
// if it can't confidently tell — the caller then just skips the photo
// rather than guessing.
var PHOTO_MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};
var PHOTO_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

function getPhotoExtension(file) {
  if (file.type && PHOTO_MIME_TO_EXTENSION[file.type]) return PHOTO_MIME_TO_EXTENSION[file.type];
  var match = /\.([a-zA-Z0-9]+)$/.exec(file.name || '');
  if (match) {
    var ext = match[1].toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    if (PHOTO_ALLOWED_EXTENSIONS.indexOf(ext) !== -1) return ext;
  }
  return null;
}

// The photo bypasses this Lambda entirely — it's uploaded straight to S3 via
// a presigned POST URL the API hands out, keyed by the food's own GUID (not
// a separately-generated name), so the photo and its DynamoDB record always
// address by the same id. Only once that upload has actually succeeded (or
// immediately, if there's no photo) does /submit get called with the food's
// fields as plain JSON. The whole chain stays best-effort/non-blocking
// relative to the local add above — a failure at any step is just logged.
// Both /presigned-post and /submit now require a logged-in session (a
// deliberate spam gate — see the backend) — this function is only ever
// called when isLoggedIn() is already true, but the calls themselves still
// send `csrf` since that's what the server actually checks.
//
// Only a genuine 200 from /submit flips this food's My Foods status from
// "Local" to "Approval Pending" — a timeout, 401/403, or any other failure
// leaves it exactly as "Local", per spec.
function submitNewFoodToApi(id, name, servings, photo) {
  var extension = photo ? getPhotoExtension(photo) : null;
  var uploadStep = (photo && extension) ? uploadPhotoViaPresignedPost(id, extension, photo) : Promise.resolve(null);

  uploadStep
    .then(function (photoKey) {
      return postSubmitJson(id, name, servings, photoKey);
    })
    .then(function (res) {
      if (res && res.status === 200) {
        dbGetMySubmission(id, function (existing) {
          var record = existing || { id: id, createdAt: nowSec() };
          record.submittedAt = nowSec();
          record.submitStatus = 'pending';
          dbPutMySubmission(record, function () { syncFoods(); });
        });
      }
    })
    .catch(function (err) {
      console.log('New food submission failed (non-blocking)', err);
    });
}

function uploadPhotoViaPresignedPost(id, extension, photo) {
  return xhrPostJson(PRESIGNED_POST_URL, { id: id, extension: extension, csrf: getCsrf() })
    .then(function (res) {
      if (res.status !== 200 || !res.data) throw new Error('Could not get a presigned upload URL (HTTP ' + res.status + ')');
      var presigned = res.data;
      var formData = new FormData();
      Object.keys(presigned.fields).forEach(function (key) {
        formData.append(key, presigned.fields[key]);
      });
      formData.append('file', photo); // must be appended last — S3's required presigned-POST form shape
      // Different origin (S3, not our API) — no cookie/csrf involved, so
      // this leg stays on fetch() rather than xhrPostJson.
      return fetch(presigned.url, { method: 'POST', body: formData });
    })
    .then(function (uploadRes) {
      if (!uploadRes.ok) throw new Error('Photo upload to S3 failed');
      return id + '.' + extension;
    });
}

function postSubmitJson(id, name, servings, photoKey) {
  var body = {
    id: id,
    name: name,
    servings: servings,
    csrf: getCsrf()
  };
  if (photoKey) body.photoKey = photoKey;
  return xhrPostJson(SUBMIT_URL, body);
}

// ─── Screen: Options ──────────────────────────────────────────────────────────

function refreshOptionsAccountRow() {
  document.getElementById('opt-login-label').textContent = isLoggedIn()
    ? 'Account (Logged In)'
    : 'Log In to sync across devices';
  dbGetAllMySubmissions(function (subs) {
    if (!subs.length) { document.getElementById('opt-my-foods-count').textContent = ''; return; }
    var remaining = subs.length;
    var visible = 0;
    subs.forEach(function (sub) {
      dbGetFood(sub.id, function (food) {
        if (food && food.deleted !== true) visible++;
        remaining--;
        if (remaining === 0) {
          document.getElementById('opt-my-foods-count').textContent = visible ? String(visible) : '';
        }
      });
    });
  });
}

function showOptionsPanel() {
  document.getElementById('opt-version').textContent = APP_VERSION;
  document.getElementById('opt-show-caffeine-value').textContent = getShowCaffeine() ? 'On' : 'Off';
  refreshOptionsAccountRow();

  var err = getLastSyncError();
  var errRow = document.getElementById('opt-sync-error-row');
  if (err) {
    errRow.style.display = '';
    errRow.setAttribute('nav-selectable', 'true');
    document.getElementById('opt-sync-error-value').textContent = err.message;
  } else {
    errRow.style.display = 'none';
    errRow.setAttribute('nav-selectable', 'false');
  }

  showPanel('panel-options');
  setSoftkeys('Back', 'SELECT', '');
}

document.getElementById('opt-clear-db').addEventListener('click', confirmClearLocalDb);

document.getElementById('opt-login').addEventListener('click', function () {
  if (isLoggedIn()) {
    openAccountSheet();
  } else {
    showLoginEmailPanel();
  }
});

document.getElementById('opt-my-foods').addEventListener('click', showMyFoodsPanel);

document.getElementById('opt-show-caffeine').addEventListener('click', function () {
  setShowCaffeine(!getShowCaffeine());
  document.getElementById('opt-show-caffeine-value').textContent = getShowCaffeine() ? 'On' : 'Off';
});

document.getElementById('opt-sync-error-row').addEventListener('click', function () {
  var err = getLastSyncError();
  if (!err) return;
  openSheet(
    [{ label: 'Dismiss', action: function () { closeSheet(); } }],
    { title: 'Last Sync Error', note: err.at + ' — ' + err.message }
  );
});

// Temporary diagnostic: hits the Lambda's throwaway /debug-headers GET route
// (see backend/lambda/lambda_function.py) and shows back exactly what
// headers this device's GET request actually arrived with — specifically
// whether 'origin' is present. Confirmed via the fetch() variant that Gecko
// 84 on real KaiOS 3.0 hardware omits Origin on fetch() GETs; the XHR variant
// exists to check whether the older XMLHttpRequest API has the same gap.
// Remove both once that's fully sorted out.
function checkDebugHeaders(sendRequest) {
  openSheet(
    [{ label: 'Dismiss', action: function () { closeSheet(); } }],
    { title: 'Checking…', note: 'Requesting ' + API_HOST + '/debug-headers' }
  );
  sendRequest()
    .then(function (data) {
      var headers = data.headers || {};
      var hasOrigin = Object.prototype.hasOwnProperty.call(headers, 'origin');
      var lines = 'origin present: ' + (hasOrigin ? ('yes (' + headers.origin + ')') : 'NO') + '\n\n' +
        JSON.stringify(headers);
      openSheet(
        [{ label: 'Dismiss', action: function () { closeSheet(); } }],
        { title: 'Request Headers', note: lines }
      );
    })
    .catch(function (err) {
      openSheet(
        [{ label: 'Dismiss', action: function () { closeSheet(); } }],
        { title: 'Request Headers', note: 'Request itself failed: ' + describeFetchError(err) }
      );
    });
}

document.getElementById('opt-check-headers').addEventListener('click', function () {
  checkDebugHeaders(function () {
    return fetch(API_HOST + '/debug-headers').then(function (res) { return res.json(); });
  });
});

document.getElementById('opt-check-headers-xhr').addEventListener('click', function () {
  checkDebugHeaders(function () {
    return xhrGetJson(API_HOST + '/debug-headers');
  });
});

function confirmClearLocalDb() {
  openSheet(
    [
      {
        label: 'Yes, delete the local DB',
        danger: true,
        action: function () { closeSheet(); doClearLocalDb(); }
      },
      {
        label: 'No, do not delete',
        action: function () { closeSheet(); }
      }
    ],
    {
      title: 'Clear local database?',
      note: 'Are you sure you want to clear the local database? All diary entries, custom foods, and recipes will be deleted permanently.'
    }
  );
}

function doClearLocalDb() {
  if (db) { db.close(); db = null; }
  var req = indexedDB.deleteDatabase(DB_NAME);
  req.onsuccess = function () { window.location.reload(); };
  req.onerror = function () { showStatus('Could not clear the local database', true); };
  req.onblocked = function () { window.location.reload(); };
}

// ─── Screen: My Foods ─────────────────────────────────────────────────────────
//
// Status is computed purely from local data — there is no backend endpoint
// to ask "was my submission approved or rejected" (admin routes aren't
// reachable by end users at all). A food's own `source` flag (set to
// 'catalog' only when the normal manifest sync downloads/overwrites it,
// which only happens once it's actually been approved+exported) is the sole
// "Approved" signal; the backend's 30-day pending-submission TTL is the
// basis for "still not there after 30 days ⇒ Rejected".

var MY_FOOD_REJECT_AFTER_DAYS = 30;

var MY_FOOD_STATUS_LABELS = {
  local: 'Local',
  pending: 'Approval Pending',
  approved: 'Approved',
  rejected: 'Rejected'
};

function computeMyFoodStatus(submissionRecord, foodRecord) {
  if (foodRecord && foodRecord.source === 'catalog') return 'approved';
  if (submissionRecord.submitStatus === 'pending') {
    var ageDays = (nowSec() - (submissionRecord.submittedAt || 0)) / (24 * 60 * 60);
    return ageDays < MY_FOOD_REJECT_AFTER_DAYS ? 'pending' : 'rejected';
  }
  return 'local';
}

function showMyFoodsPanel() {
  renderMyFoodsList(function () {
    showPanel('panel-my-foods');
    setSoftkeys('Back', 'SELECT', '');
  });
}

function renderMyFoodsList(callback) {
  dbGetAllMySubmissions(function (subs) {
    var ul = document.getElementById('my-foods-ul');
    ul.innerHTML = '';
    if (!subs.length) {
      document.getElementById('my-foods-empty').style.display = 'block';
      if (callback) callback();
      return;
    }
    var remaining = subs.length;
    var rows = new Array(subs.length); // preserve stable order regardless of which food loads first
    subs.forEach(function (sub, idx) {
      dbGetFood(sub.id, function (food) {
        // A deleted (tombstoned) or altogether-missing food's mySubmissions
        // row deliberately survives a delete so /sync/foods can still
        // report it (see deleteMyFood) — it just never renders here.
        if (!food || food.deleted === true) {
          rows[idx] = null;
        } else {
          var status = computeMyFoodStatus(sub, food);
          var li = document.createElement('li');
          li.className = 'options-row my-food-row';
          li.setAttribute('nav-selectable', 'true');
          li.setAttribute('data-food-id', sub.id);

          var name = document.createElement('span');
          name.className = 'options-label';
          name.textContent = food.name;

          var statusEl = document.createElement('span');
          statusEl.className = 'options-value my-food-status-' + status;
          statusEl.textContent = MY_FOOD_STATUS_LABELS[status];

          li.appendChild(name);
          li.appendChild(statusEl);
          li.addEventListener('click', function () { openMyFoodActionsSheet(sub.id, status); });
          rows[idx] = li;
        }

        remaining--;
        if (remaining === 0) {
          var visibleRows = rows.filter(function (row) { return row !== null; });
          visibleRows.forEach(function (row) { ul.appendChild(row); });
          document.getElementById('my-foods-empty').style.display = visibleRows.length ? 'none' : 'block';
          if (callback) callback();
        }
      });
    });
  });
}

function openMyFoodActionsSheet(foodId, status) {
  var items = [];
  if (status === 'local' || status === 'rejected') {
    items.push({ label: 'Re-submit for approval', action: function () { closeSheet(); resubmitFood(foodId); } });
  }
  items.push({ label: 'Delete', danger: true, action: function () { closeSheet(); deleteMyFood(foodId); } });
  items.push({ label: 'Cancel', action: function () { closeSheet(); } });
  openSheet(items, { title: MY_FOOD_STATUS_LABELS[status], note: 'What would you like to do with this food?' });
}

// Diary history referencing this food is deliberately left intact (matches
// the app's existing graceful degradation when a diary entry's food can no
// longer be found — see showServingsPanel).
function deleteMyFood(foodId) {
  function afterUiUpdate() {
    renderMyFoodsList(function () {
      refreshOptionsAccountRow();
      showStatus('Deleted', false);
      syncFoods();
    });
  }
  // A device that's never logged in has nothing to reconcile — a real hard
  // delete, mySubmissions included. Once it's ever logged in, the `foods`
  // record becomes a tombstone instead (see dbSoftDeleteFood) — but the
  // mySubmissions row must survive this delete, not be removed immediately,
  // since buildFoodsSyncPayload() only ever reports ids it still has a
  // mySubmissions row for; deleting that row right away would mean the
  // very next /sync/foods call never learns this id was deleted at all.
  // renderMyFoodsList already hides any row whose `foods` record is
  // deleted, so this doesn't linger visibly.
  if (getEverLoggedIn()) {
    dbSoftDeleteFood(foodId, function () {
      if (state.foodsById[foodId]) state.foodsById[foodId].deleted = true;
      afterUiUpdate();
    });
  } else {
    delete state.foodsById[foodId];
    state.allFoods = state.allFoods.filter(function (f) { return f.id !== foodId; });
    var tx = db.transaction('foods', 'readwrite');
    tx.objectStore('foods').delete(foodId);
    tx.oncomplete = function () { dbDeleteMySubmission(foodId, afterUiUpdate); };
    tx.onerror = function () { dbDeleteMySubmission(foodId, afterUiUpdate); };
  }
}

// Only ever resends name/servings — the original nutrition-facts photo was
// uploaded once at creation and was never persisted locally afterward, so a
// re-submit can't re-attach one.
function resubmitFood(foodId) {
  if (!isLoggedIn()) {
    showStatus('Log in to submit foods', true);
    showLoginEmailPanel();
    return;
  }
  dbGetFood(foodId, function (food) {
    if (!food) { showStatus('Food data unavailable', true); return; }
    postSubmitJson(foodId, food.name, food.servings, null).then(function (res) {
      if (res && res.status === 200) {
        dbGetMySubmission(foodId, function (existing) {
          var record = existing || { id: foodId, createdAt: nowSec() };
          record.submittedAt = nowSec();
          record.submitStatus = 'pending';
          dbPutMySubmission(record, function () {
            renderMyFoodsList(function () {
              refreshOptionsAccountRow();
              showStatus('Submitted for approval', false);
              syncFoods();
            });
          });
        });
      } else {
        showStatus('Could not submit — still Local', true);
      }
    }).catch(function () {
      showStatus('Could not submit — still Local', true);
    });
  });
}

// ─── Screen: Login ────────────────────────────────────────────────────────────
//
// Lifted from kaios-shared-list/frontend-v3's own email+OTP flow — same
// backend auth pattern (backend/lambda/calorie_api/account.py), same UI
// shape/copy, adapted to this app's softkey conventions.

var _otpRequestInFlight = false;
var _pendingLoginEmail = null;

function showLoginEmailPanel() {
  document.getElementById('input-login-email').value = '';
  showPanel('panel-login-email');
  setSoftkeys('Back', 'Next', '');
}

function resetLoginEmailForm() {
  _otpRequestInFlight = false;
  document.getElementById('input-login-email').disabled = false;
}

function submitLoginEmail() {
  if (_otpRequestInFlight) return;
  var email = document.getElementById('input-login-email').value.trim();
  if (!email) {
    showStatus('Enter your email address', true);
    return;
  }
  _otpRequestInFlight = true;
  document.getElementById('input-login-email').disabled = true;
  xhrPostJson(ACCOUNT_OTP_URL, { email: email }).then(function (res) {
    resetLoginEmailForm();
    if (res.status === 200) {
      _pendingLoginEmail = email;
      showLoginOtpPanel(email);
    } else {
      showStatus((res.data && res.data.message) || 'Failed to send code', true);
    }
  }).catch(function () {
    resetLoginEmailForm();
    showStatus('Network error', true);
  });
}

document.getElementById('input-login-email').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLoginEmail();
  }
});

document.getElementById('btn-login-email-privacy').addEventListener('click', function () {
  openSheet(
    [{ label: 'Got it', action: function () { closeSheet(); } }],
    {
      title: 'What do we do with your email?',
      note: 'We only use it to send you a one-time sign-in code. The address itself is not stored in our database — only a cryptographic hash is kept so we can recognize you on future visits. After your code is sent, the email address is no longer retained and is not logged.'
    }
  );
});

function showLoginOtpPanel(email) {
  document.getElementById('login-otp-hint').textContent = 'Code sent to ' + email;
  document.getElementById('input-login-otp').value = '';
  showPanel('panel-login-otp');
  setSoftkeys('Back', 'Verify', '');
}

function submitLoginOtp() {
  var otp = document.getElementById('input-login-otp').value.trim();
  if (!otp) {
    showStatus('Enter the code from your email', true);
    return;
  }
  xhrPostJson(ACCOUNT_LOGIN_URL, { email: _pendingLoginEmail, otp: otp }).then(function (res) {
    if (res.status === 200) {
      var csrf = res.getHeader('x-csrf-token');
      if (csrf) setCsrf(csrf);
      markEverLoggedIn();
      setAuthDotState();
      showOptionsPanel();
      showStatus('Logged in', false);
      runFullSync();
    } else {
      var message = (res.data && res.data.message) || 'Incorrect code';
      var waitMatch = message.match(/(\d+) seconds/);
      if (waitMatch) {
        var remaining = parseInt(waitMatch[1], 10);
        var hintEl = document.getElementById('login-otp-hint');
        var origHint = hintEl.textContent;
        var input = document.getElementById('input-login-otp');
        input.disabled = true;
        hintEl.textContent = 'Try again in ' + remaining + 's...';
        var timer = setInterval(function () {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(timer);
            input.disabled = false;
            hintEl.textContent = origHint;
          } else {
            hintEl.textContent = 'Try again in ' + remaining + 's...';
          }
        }, 1000);
      } else {
        showStatus(message, true);
      }
    }
  }).catch(function () {
    showStatus('Network error', true);
  });
}

document.getElementById('input-login-otp').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLoginOtp();
  }
});

function openAccountSheet() {
  openSheet(
    [
      { label: 'Log Out', action: function () { closeSheet(); logOut(); } },
      { label: 'Log Out Everywhere', danger: true, action: function () { closeSheet(); logOutAllDevices(); } },
      { label: 'Cancel', action: function () { closeSheet(); } }
    ],
    { title: 'Account', note: 'You are logged in and syncing across devices.' }
  );
}

function logOut() {
  clearCsrf();
  setAuthDotState();
  refreshOptionsAccountRow();
  showStatus('Logged out', false);
}

function logOutAllDevices() {
  xhrPostJson(ACCOUNT_LOG_OUT_ALL_URL, { csrf: getCsrf() }).then(function (res) {
    logOut();
    showStatus(res.status === 200 ? 'Logged out everywhere' : 'Logged out here, but could not confirm everywhere', res.status !== 200);
  }).catch(function () {
    logOut();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

applyCaffeineVisibility();
setAuthDotState();

openDB(function () {
  purgeOldTombstonesLocally(function () {});
  syncData(
    function onFileStart(index, total, fileEntry) {
      showPanel('panel-loading');
      var filename = fileEntry.url.replace(/^\//, '');
      document.getElementById('loading-count').textContent = 'Loading ' + index + ' of ' + total + ' database files…';
      document.getElementById('loading-filename').textContent = filename;
      document.getElementById('loading-progress-fill').style.width = '0%';
    },
    function onFileProgress(fraction) {
      var pct = fraction === null ? 100 : Math.round(fraction * 100);
      document.getElementById('loading-progress-fill').style.width = pct + '%';
    },
    function onDone() {
      dbGetAllFoods(function (foods) {
        state.allFoods = foods;
        state.foodsById = {};
        foods.forEach(function (f) { state.foodsById[f.id] = f; });
        dbGetAllUsageCounts(function (records) {
          state.usageCounts = {};
          records.forEach(function (r) { state.usageCounts[r.id] = r.count; });
          dbGetAllLastServings(function (servingRecords) {
            state.lastServings = {};
            servingRecords.forEach(function (r) {
              state.lastServings[r.id] = { servingName: r.servingName, quantity: r.quantity };
            });
            showDiaryPanel();
            if (isLoggedIn()) {
              accountRefreshIfNeeded();
              runFullSync();
            }
          });
        });
      });
    }
  );
});
