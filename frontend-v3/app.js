'use strict';

var DATA_HOST = 'https://calories.elliscode.com';
var API_HOST = 'https://api.calories.elliscode.com';
var SUBMIT_URL = API_HOST + '/submit';
var LOOKUP_UPC_URL = API_HOST + '/lookup-upc';
var SEARCH_URL = API_HOST + '/search';
var SUBMIT_UPC_MAPPING_URL = API_HOST + '/submit-upc-mapping';
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
var APP_VERSION = '3.0.41';

var SUMMARY_KEYS = ['calories', 'fat', 'carbohydrates', 'protein', 'caffeine', 'alcohol'];
var NON_NUTRIENT_KEYS = [
  'id', 'date', 'foodId', 'foodName', 'servingName', 'quantity', 'name',
  'guid', 'updated', 'deleted', 'type', 'mealId'
];

var state = {
  currentDate: todayStr(),
  allFoods: [],
  foodsById: {},
  usageCounts: {},
  lastServings: {},
  tray: [],
  diaryEntries: [],
  editingEntry: null,
  editingFood: null,
  // 'diary' (normal) or 'recipe-ingredient' (picking a food to add as a
  // recipe ingredient instead of logging it) — see showSearchPanel() /
  // showSearchPanelForRecipeIngredient(), which are the only two entry
  // points into Search and each set this explicitly, so it never leaks.
  searchMode: 'diary',
  // 'diary' (normal, editing a diary entry), 'recipe-ingredient' (picking a
  // quantity/unit for a food being added to a recipe), or 'diary-add' (the
  // mandatory add-time serving+meal confirmation, gateOrAddToDiary) — see
  // showServingsPanel() / showRecipeIngredientQtyPanel() / showDiaryAddConfirmPanel().
  servingsMode: 'diary',
  recipeBuilder: null,
  // {onComplete, onCancel} while panel-servings is open in 'diary-add'
  // mode — see showDiaryAddConfirmPanel/commitDiaryAdd. null otherwise.
  pendingDiaryAdd: null,
  // Where handleSoftLeft() sends Back from panel-my-foods/panel-my-recipes
  // — 'options' (the only route at ≤240px) unless the new >240px Foods &
  // Recipes chooser (panel-foods-recipes) was the one that opened it.
  // Options' own My Foods/My Recipes rows reset this to 'options' on every
  // click so stale state from an earlier chooser visit can't leak in.
  myFoodsBackTo: 'options'
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

// Shared by every search predicate in this file (renderSearchResults,
// renderScanMatchResults) — punctuation is stripped (not replaced with a
// space) from both the query and the candidate name before matching, so
// e.g. "moms" matches "Mom's" and "mac n cheese" matches "Mac & Cheese".
// A static character class rather than \p{L}-style Unicode regex classes,
// since this codebase targets an old KaiOS Gecko 84 build with iffy modern-
// regex support (see xhrGetJson's fetch()-header comment for another
// example of that same hardware quirk) — mirrored in
// backend/lambda/calorie_api/search.py's _normalize_for_search so the
// remote catalog search behaves the same way.
var SEARCH_PUNCTUATION_REGEX = /[.,/#!$%^&*;:{}=\-_`~()'"?[\]\\|<>+@]/g;

// Punctuation is stripped outright (not replaced with a space), which can
// leave a run of two spaces behind where one used to sit next to it (e.g.
// "Mac & Cheese" -> "mac  cheese") — collapsed back down to one so a
// naturally single-spaced query like "mac cheese" still substring-matches.
function normalizeForSearch(s) {
  return (s || '').toLowerCase().replace(SEARCH_PUNCTUATION_REGEX, '').replace(/\s+/g, ' ').trim();
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

// Shared by every field in the `settings` sync blob (showCaffeine, and now
// the Meals fields below) — the backend merges `settings` as one atomic
// unit keyed on a single `updated` timestamp (see sync.py's
// sync_preferences_route), not per-field, so there's deliberately only ever
// one of these regardless of how many settings fields exist. localStorage
// key kept as `showCaffeineUpdatedAt` (not renamed) so existing installs
// don't lose their timestamp.
function getSettingsUpdatedAt() {
  try { return parseInt(localStorage.getItem('showCaffeineUpdatedAt'), 10) || 0; } catch (e) { return 0; }
}

function setSettingsUpdatedAt(ts) {
  try { localStorage.setItem('showCaffeineUpdatedAt', String(ts)); } catch (e) { /* ignore */ }
}

function setShowCaffeine(show) {
  try { localStorage.setItem('showCaffeine', String(show)); } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  applyCaffeineVisibility();
  syncPreferences();
}

function applyCaffeineVisibility() {
  var display = getShowCaffeine() ? '' : 'none';
  var rowSum = document.getElementById('row-sum-caffeine');
  var rowServ = document.getElementById('row-serv-caffeine');
  var rowRecipe = document.getElementById('row-recipe-caffeine');
  if (rowSum) rowSum.style.display = display;
  if (rowServ) rowServ.style.display = display;
  if (rowRecipe) rowRecipe.style.display = display;
}

// ─── Show Alcohol setting ────────────────────────────────────────────────
// Exact mirror of Show Caffeine above — alcohol has no input on the
// "+ Add New Food" form either (admin-review-only field), most foods just
// show "0 g", which not everyone cares to see. Defaults to off.
function getShowAlcohol() {
  try {
    var raw = localStorage.getItem('showAlcohol');
    return raw === null ? false : raw === 'true';
  } catch (e) { return false; }
}

function setShowAlcohol(show) {
  try { localStorage.setItem('showAlcohol', String(show)); } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  applyAlcoholVisibility();
  syncPreferences();
}

function applyAlcoholVisibility() {
  var display = getShowAlcohol() ? '' : 'none';
  var rowSum = document.getElementById('row-sum-alcohol');
  var rowServ = document.getElementById('row-serv-alcohol');
  var rowRecipe = document.getElementById('row-recipe-alcohol');
  if (rowSum) rowSum.style.display = display;
  if (rowServ) rowServ.style.display = display;
  if (rowRecipe) rowRecipe.style.display = display;
}

// ─── After I add a food… setting ────────────────────────────────────────
// Independent of Meals/Require Meal Selection below — this is the general
// "stop at the servings-confirmation screen every time" switch, usable with
// Meals off entirely. 'modify' is the default — reviewing the serving
// before it lands in the diary is the recommended flow; 'direct' is the
// opt-out back to the old instant-add behavior.
function getAfterAddFood() {
  try { return localStorage.getItem('afterAddFood') === 'direct' ? 'direct' : 'modify'; } catch (e) { return 'modify'; }
}

function setAfterAddFood(mode) {
  try { localStorage.setItem('afterAddFood', mode); } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  syncPreferences();
}

// ─── Meals setting ──────────────────────────────────────────────────────
// On by default — grouping the diary by meal. Meal names/order
// live in the same `settings` sync blob as showCaffeine (see
// getSettingsUpdatedAt above) rather than their own IndexedDB store/sync
// collection — this list is edited rarely, so the whole-blob-newer-wins
// tradeoff already accepted for showCaffeine is an acceptable fit, and it
// makes reordering free (array position IS the order, no separate field to
// reconcile across devices).

var DEFAULT_MEALS = [
  { id: 'breakfast', name: 'Breakfast' },
  { id: 'lunch', name: 'Lunch' },
  { id: 'dinner', name: 'Dinner' },
  { id: 'snacks', name: 'Snacks' }
];

function getMealsEnabled() {
  try {
    var raw = localStorage.getItem('mealsEnabled');
    return raw === null ? true : raw === 'true'; // default ON
  } catch (e) { return true; }
}

function setMealsEnabled(on) {
  try { localStorage.setItem('mealsEnabled', String(on)); } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  syncPreferences();
}

function getRequireMealSelection() {
  try {
    var raw = localStorage.getItem('requireMealSelection');
    return raw === null ? true : raw === 'true'; // default ON
  } catch (e) { return true; }
}

function setRequireMealSelection(on) {
  try { localStorage.setItem('requireMealSelection', String(on)); } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  syncPreferences();
}

// getMeals() doubles as the one-time seed for the four default meals —
// there's no onupgradeneeded-style hook for a localStorage value, so
// seeding happens lazily on first read instead. `mealsSeeded` (distinct
// from "the array is empty") is what stops a user who deliberately deletes
// every meal from having them silently reappear on the next read.
function getMeals() {
  try {
    var raw = localStorage.getItem('meals');
    if (raw === null) {
      if (localStorage.getItem('mealsSeeded') === 'true') return [];
      localStorage.setItem('meals', JSON.stringify(DEFAULT_MEALS));
      localStorage.setItem('mealsSeeded', 'true');
      return DEFAULT_MEALS.slice();
    }
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function setMeals(meals) {
  try {
    localStorage.setItem('meals', JSON.stringify(meals));
    localStorage.setItem('mealsSeeded', 'true');
  } catch (e) { /* ignore */ }
  setSettingsUpdatedAt(nowSec());
  syncPreferences();
}

function applyMealsVisibility() {
  var on = getMealsEnabled();
  var display = on ? '' : 'none';
  ['opt-meals', 'opt-require-meal-selection'].forEach(function (id) {
    var row = document.getElementById(id);
    row.style.display = display;
    row.setAttribute('nav-selectable', on ? 'true' : 'false');
  });
}

function refreshOptionsMealsCount() {
  var count = getMeals().length;
  document.getElementById('opt-meals-count').textContent = count ? String(count) : '';
}

// Shared by every place a meal-picker <select> shows up: panel-servings
// (both editing an existing entry and the add-time confirmation) and the
// Guesstimate form's own inline field.
function applyMealFieldVisibility(wrapId, show) {
  var wrap = document.getElementById(wrapId);
  wrap.style.display = show ? '' : 'none';
  wrap.setAttribute('nav-selectable', show ? 'true' : 'false');
}

// `required`: adds a disabled "— Select a meal —" placeholder, initially
// selected, that callers reject as an invalid submission until changed.
// "Other" (value '') is always a real, selectable choice even when
// required — mandatory means the step itself can't be skipped, not that
// "no meal" is a banned answer.
function populateMealSelect(selectEl, selectedMealId, required) {
  selectEl.innerHTML = '';
  if (required) {
    var placeholder = document.createElement('option');
    placeholder.value = '__unset__';
    placeholder.textContent = '— Select a meal —';
    placeholder.disabled = true;
    selectEl.appendChild(placeholder);
  }
  getMeals().forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    selectEl.appendChild(opt);
  });
  var otherOpt = document.createElement('option');
  otherOpt.value = '';
  otherOpt.textContent = 'Other';
  selectEl.appendChild(otherOpt);

  var validIds = getMeals().map(function (m) { return m.id; }).concat(['']);
  selectEl.value = (selectedMealId && validIds.indexOf(selectedMealId) !== -1)
    ? selectedMealId
    : (required ? '__unset__' : '');
}

// The seam every diary-add call site funnels through instead of calling
// addFoodToDiaryDefault/addFoodToDiaryWithServing directly. The instant
// branch is byte-for-byte what every call site already did before this
// feature existed — Meals-off/Require-off/"Return to diary" behavior is
// unchanged. Two independent gates can force the confirmation screen: the
// mandatory-meal-selection one (Meals + Require both on) and "After I add a
// food… -> Modify servings" (getAfterAddFood) — either alone is enough.
// `prefillServingName`/`prefillQuantity` non-null when the caller already
// resolved a specific serving (UPC paths); null to prefill from
// defaultServingForFood (search/Tray/new-food/recipe).
function gateOrAddToDiary(food, prefillServingName, prefillQuantity, onComplete, onCancel) {
  var mealStepMandatory = getMealsEnabled() && getRequireMealSelection();
  if (!mealStepMandatory && getAfterAddFood() !== 'modify') {
    if (prefillServingName) addFoodToDiaryWithServing(food, prefillServingName, prefillQuantity, onComplete, null);
    else addFoodToDiaryDefault(food, onComplete, null);
    return;
  }
  showDiaryAddConfirmPanel(food, prefillServingName, prefillQuantity, onComplete, onCancel);
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
var DB_VERSION = 6;

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

    // v6: local UPC-mapping lookup (upc -> {upc, foodId, servingName,
    // servingQuantity}), synced via manifest.json like `foods` — see
    // dbGetUpcMapping/dbBulkPutUpcMappings and syncData's per-file dispatch.
    if (!d.objectStoreNames.contains('upcMappings')) {
      d.createObjectStore('upcMappings', { keyPath: 'upc' });
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

    if (e.oldVersion < 5) {
      // v5: recipes and guesstimates. Neither needs a new store or index —
      // a recipe is just a `foods` record with type:'recipe' (+ ingredients/
      // servingsCount) alongside plain foods, which simply have no `type`
      // (read as `!== 'recipe'` everywhere); a guesstimate is just a `diary`
      // record with type:'guesstimate' and foodId:null, alongside plain
      // diary entries (no `type`). Both fields are purely additive with a
      // safe undefined default on every pre-existing record — there is
      // genuinely nothing to backfill. This block exists purely as living
      // documentation of the v5 shape change, mirroring every prior
      // version's block.
    }

    if (e.oldVersion < 6) {
      // v6: upcMappings, created above. Nothing to backfill — it's a wholly
      // new, empty store until the next manifest sync populates it.
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

// Mirrors dbBulkPutFoods/dbGetFood exactly, for the separate upcMappings
// store — see syncData's per-file dispatch for how these get populated.
function dbBulkPutUpcMappings(mappingsArray, callback) {
  var tx = db.transaction('upcMappings', 'readwrite');
  var store = tx.objectStore('upcMappings');
  mappingsArray.forEach(function (m) { store.put(m); });
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
}

function dbGetUpcMapping(upc, callback) {
  var tx = db.transaction('upcMappings', 'readonly');
  var req = tx.objectStore('upcMappings').get(upc);
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
// Never sent to /sync/* directly — purely local. A row here is deliberately
// wiped, not preserved, the moment its food shows up in a catalog sync (see
// syncData) — once a food is in the catalog there's nothing left to track:
// no live admin channel exists to report "yours got approved" (see
// review_route in backend/lambda/calorie_api/admin.py), so this row's only
// job was ever to drive computeMyFoodStatus()'s "pending" display before
// that point.

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

// Called with every id in a downloaded catalog file (see syncData) — most
// won't have a row at all, but deleting a non-existent key is a harmless
// no-op, cheaper than checking existence first for what's normally a
// thousand-plus id batch.
function dbBulkDeleteMySubmissions(ids, callback) {
  var tx = db.transaction('mySubmissions', 'readwrite');
  var store = tx.objectStore('mySubmissions');
  ids.forEach(function (id) { store.delete(id); });
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

// Uses XMLHttpRequest rather than fetch() — confirmed on real KaiOS 3.0
// hardware that this device's Gecko 84 build silently omits the Origin header
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
  return true;
  if (!hasAnySyncedFiles) return true; // never synced, or DB was cleared — must bootstrap
  return getLastManifestCheck() < mostRecentTuesday8am(now);
}

// onFileStart(index, total, fileEntry) fires once per file, before it starts downloading.
// onFileProgress(fraction) fires repeatedly while the current file streams in (fraction is
// null if the server didn't send a Content-Length to compute a fraction from).
// callback(filesDownloaded) reports how many files were actually pulled down, so callers
// like forceCheckManifest() can tell the user "up to date" apart from "downloaded N files".
// `force` skips the once-a-week throttle — used by that manual "Check for new data" action;
// the normal boot-time call leaves it undefined/false and stays throttled as always.
function syncData(onFileStart, onFileProgress, callback, force) {
  dbGetSyncedFileIds(function (syncedIds) {
    if (!force && !shouldCheckManifest(syncedIds.length > 0, new Date())) {
      callback(0);
      return;
    }
    xhrGetJson(DATA_HOST + '/manifest.json')
      .then(function (manifest) {
        setLastManifestCheck(Date.now());
        var toFetch = (manifest.files || []).filter(function (f) {
          return syncedIds.indexOf(f.id) === -1;
        });
        if (!toFetch.length) { setLastSyncError(null); callback(0); return; }
        fetchNext(0);
        function fetchNext(i) {
          if (i >= toFetch.length) { setLastSyncError(null); callback(toFetch.length); return; }
          var fileEntry = toFetch[i];
          onFileStart(i + 1, toFetch.length, fileEntry);
          xhrGetJson(DATA_HOST + fileEntry.url, onFileProgress)
            .then(function (items) {
              // upc-mappings files store {upc, foodId, servingName,
              // servingQuantity} rows as-is — no food-record tagging to do,
              // unlike the 'foods' branch below.
              if (fileEntry.type === 'upc-mappings') {
                dbBulkPutUpcMappings(items, function () {
                  dbMarkFileSynced(fileEntry.id, function () { fetchNext(i + 1); });
                });
                return;
              }
              // Tagged as 'catalog' here — this is the one place a food ever
              // becomes catalog data, since a user-submitted food only ever
              // reaches this path once it's been approved+exported and
              // shows up in a downloaded manifest data file under its
              // original id.
              var tagged = items.map(function (f) {
                f.source = 'catalog';
                f.updated = nowSec();
                f.deleted = false;
                return f;
              });
              dbBulkPutFoods(tagged, function () {
                // Any mySubmissions row for one of these ids is now stale —
                // see dbBulkDeleteMySubmissions above for why this drops it
                // rather than leaving an "Approved" trace behind.
                dbBulkDeleteMySubmissions(tagged.map(function (f) { return f.id; }), function () {
                  dbMarkFileSynced(fileEntry.id, function () { fetchNext(i + 1); });
                });
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
        callback(0);
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

// Enumerates every food id this account needs to keep in sync: anything
// with a mySubmissions bookkeeping row (foods submitted for catalog review)
// PLUS every local recipe (recipes never go through /submit, so they never
// get a mySubmissions row of their own, but they still need to sync).
// Forwards a food's fields generically rather than a name/servings-only
// whitelist, so a recipe's extra `type`/`ingredients`/`servingsCount`
// fields survive the round trip — the backend's own merge already passes
// through unknown fields unchanged, this was purely a client-side gap.
function buildFoodsSyncPayload(callback) {
  dbGetAllMySubmissions(function (subs) {
    dbGetAllFoods(function (allFoods) {
      var ids = {};
      subs.forEach(function (s) { ids[s.id] = true; });
      allFoods.forEach(function (f) {
        if (f.type === 'recipe' && f.source === 'local') ids[f.id] = true;
      });
      var idList = Object.keys(ids);
      if (!idList.length) { callback({}); return; }
      var payload = {};
      var remaining = idList.length;
      idList.forEach(function (id) {
        dbGetFood(id, function (food) {
          if (food) {
            var item = { updated: food.updated || nowSec(), deleted: food.deleted === true };
            Object.keys(food).forEach(function (k) {
              if (k === 'id' || k === 'source' || k === 'updated' || k === 'deleted') return;
              item[k] = food[k]; // name, servings, and — for recipes — type/ingredients/servingsCount
            });
            payload[id] = item;
          }
          remaining--;
          if (remaining === 0) callback(payload);
        });
      });
    });
  });
}

// `merged` is {foodId: {...fields, updated, deleted}}. If a food is already
// known locally as a real catalog entry (source:'catalog' — i.e. it was
// already approved+exported and downloaded via the normal manifest sync),
// that status wins and this merge doesn't touch it at all — not even
// deleted/updated — even though this same id is also present in the
// account's own synced-foods collection server-side. Skipping it entirely
// (rather than just protecting `source`) matters: buildFoodsSyncPayload only
// reports an id it still has a mySubmissions row for, and a local DB clear
// wipes mySubmissions along with everything else — so the very next
// /sync/foods call after a clear says nothing about this food, and the
// server dutifully echoes back whatever it last knew (e.g. an old delete
// tombstone from before the clear). Applying that here would silently
// re-hide a food syncData just finished correctly resurrecting from the
// catalog. A catalog food's local state is only ever supposed to come from
// syncData's manifest sync, never from this account-level merge. Forwards
// fields generically for everything else, same reasoning as
// buildFoodsSyncPayload above — a recipe's extra fields must survive coming
// back in too, not just going out.
function applyFoodsSyncMerge(merged, callback) {
  var ids = Object.keys(merged);
  if (!ids.length) { callback(); return; }
  var remaining = ids.length;
  function done() { remaining--; if (remaining === 0) callback(); }
  ids.forEach(function (id) {
    var item = merged[id];
    dbGetFood(id, function (existing) {
      if (existing && existing.source === 'catalog') { done(); return; }
      var food = { id: id, source: 'local' };
      Object.keys(item).forEach(function (k) { food[k] = item[k]; });
      dbBulkPutFoods([food], function () {
        upsertStateFood(food);
        done();
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
// against the catalog regardless. Recipes are explicitly excluded — they
// never go through catalog submission, so a recipe synced down from
// another device must never get a spurious mySubmissions row (which would
// leak it into My Foods with a bogus status). A catalog food is excluded
// too, and for a stronger reason than "spurious status": this account's own
// synced-foods data can be stale (e.g. it still remembers this id from
// before it was approved), and this function runs right after syncData may
// have just deleted this exact id's mySubmissions row on purpose (see
// dbBulkDeleteMySubmissions) — recreating it here would silently undo that.
function reconcileMySubmissionsFromFoodsSync(merged, callback) {
  var ids = Object.keys(merged).filter(function (id) {
    return merged[id].deleted !== true && merged[id].type !== 'recipe';
  });
  if (!ids.length) { callback(); return; }
  dbGetAllMySubmissions(function (subs) {
    var known = {};
    subs.forEach(function (s) { known[s.id] = true; });
    var missing = ids.filter(function (id) { return !known[id]; });
    if (!missing.length) { callback(); return; }
    var remaining = missing.length;
    function done() { remaining--; if (remaining === 0) callback(); }
    missing.forEach(function (id) {
      dbGetFood(id, function (existing) {
        if (existing && existing.source === 'catalog') { done(); return; }
        var approxTime = merged[id].updated || nowSec();
        dbPutMySubmission({ id: id, createdAt: approxTime, submittedAt: approxTime, submitStatus: 'pending' }, done);
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
  if (merged.settings) {
    // Writes localStorage directly rather than through the setters — the
    // setters each call syncPreferences() themselves, which would turn
    // applying a sync response into triggering another sync.
    if (typeof merged.settings.showCaffeine === 'boolean') {
      try { localStorage.setItem('showCaffeine', String(merged.settings.showCaffeine)); } catch (e) { /* ignore */ }
    }
    if (typeof merged.settings.showAlcohol === 'boolean') {
      try { localStorage.setItem('showAlcohol', String(merged.settings.showAlcohol)); } catch (e) { /* ignore */ }
    }
    if (typeof merged.settings.mealsEnabled === 'boolean') {
      try { localStorage.setItem('mealsEnabled', String(merged.settings.mealsEnabled)); } catch (e) { /* ignore */ }
    }
    if (typeof merged.settings.requireMealSelection === 'boolean') {
      try { localStorage.setItem('requireMealSelection', String(merged.settings.requireMealSelection)); } catch (e) { /* ignore */ }
    }
    if (merged.settings.afterAddFood === 'modify' || merged.settings.afterAddFood === 'direct') {
      try { localStorage.setItem('afterAddFood', merged.settings.afterAddFood); } catch (e) { /* ignore */ }
    }
    if (Array.isArray(merged.settings.meals)) {
      try {
        localStorage.setItem('meals', JSON.stringify(merged.settings.meals));
        localStorage.setItem('mealsSeeded', 'true'); // a merge response means this account has real settings, seeded or not
      } catch (e) { /* ignore */ }
    }
    if (merged.settings.updated) setSettingsUpdatedAt(merged.settings.updated);
    applyCaffeineVisibility();
    applyAlcoholVisibility();
    applyMealsVisibility();
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
        settings: {
          showCaffeine: getShowCaffeine(),
          showAlcohol: getShowAlcohol(),
          mealsEnabled: getMealsEnabled(),
          requireMealSelection: getRequireMealSelection(),
          afterAddFood: getAfterAddFood(),
          meals: getMeals(),
          // Deliberately NOT `|| nowSec()` — 0 means "this device has never
          // changed a setting locally," and must stay 0 (always loses the
          // newest-updated-wins merge below) rather than be stamped with
          // the current time. Otherwise a brand-new/never-touched device's
          // very first sync would look newer than another device's real,
          // previously-pushed settings and silently clobber them — every
          // setter (setShowCaffeine, setMealsEnabled, etc.) already calls
          // setSettingsUpdatedAt(nowSec()) itself the moment there's an
          // actual local change to report.
          updated: getSettingsUpdatedAt()
        },
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
  // isVisible() filter matters now that some nav-selectable elements are
  // conditionally hidden at the current width (e.g. #btn-diary-add-food
  // vs. the >240px Diary bottom nav) — without it, this could focus (and
  // report as the active softkey/top-bar action) an element the user can't
  // actually see or interact with.
  var candidates = panel.querySelectorAll('[nav-selectable="true"]');
  var first = null;
  for (var j = 0; j < candidates.length; j++) {
    if (isVisible(candidates[j])) { first = candidates[j]; break; }
  }
  if (first) setFocus(first);
}

// #topbar-back/#topbar-accept (the >240px touchscreen UI's Back/Accept —
// see index.html) are kept in sync here rather than at each of
// setSoftkeys()'s many call sites: whenever there's no left/center softkey
// action for the current panel/sheet state, there's nothing for the
// matching top-bar button to do either, so it's hidden the same way
// (.topbar-btn-empty, see css/header.css). aria-label mirrors the actual
// action text ("Back" vs "Cancel", "Save" vs "Submit" vs "Verify", etc.)
// since the icon itself stays generic/static.
function setSoftkeys(left, center, right) {
  document.getElementById('sk-left').textContent = left;
  document.getElementById('sk-center').textContent = center;
  document.getElementById('sk-right').textContent = right;

  var backBtn = document.getElementById('topbar-back');
  backBtn.classList.toggle('topbar-btn-empty', !left);
  if (left) backBtn.setAttribute('aria-label', left);

  var acceptBtn = document.getElementById('topbar-accept');
  acceptBtn.classList.toggle('topbar-btn-empty', !center);
  if (center) acceptBtn.setAttribute('aria-label', center);

  // >240px touchscreen UI only: 'SELECT' is the generic "whatever's
  // focused, activate it" label handleSoftCenter()'s fallback case uses
  // for every plain list/tap-to-choose screen (Options, My Foods, My
  // Recipes, the Foods & Recipes chooser, Meals) — exactly what tapping a
  // row already does directly, so the top-bar checkmark has no real job
  // there (same reasoning as panel-diary's explicit override in
  // updateSoftkeysForFocus() for its own, differently-labeled case).
  // Belongs here rather than in updateSoftkeysForFocus() because several
  // show*Panel functions (showOptionsPanel, showMyFoodsPanel, etc.) call
  // setSoftkeys() a second time directly right after showPanel()'s own
  // focus-triggered call — anywhere else, that second call would win and
  // undo the override.
  if (center === 'SELECT') acceptBtn.classList.add('topbar-btn-empty');
}

function updateSoftkeysForFocus() {
  if (isSheetOpen()) return; // openSheet()/closeSheet() own the softkeys while it's up
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-diary') {
    var focusedEl = focused();
    var onAddFood = focusedEl && focusedEl.id === 'btn-diary-add-food';
    // 'Edit' only makes sense with focus actually on a diary entry — at
    // >240px, with #btn-diary-add-food hidden (see the Diary bottom nav)
    // and an empty/short diary, focus can land on the date field or a
    // bottom-nav button instead, neither of which has a "commit" action.
    var onFoodRow = focusedEl && focusedEl.classList.contains('food-row');
    setSoftkeys('', onAddFood ? 'Add' : (onFoodRow ? 'Edit' : ''), 'Options');
    // #sk-center's "Edit" label above is real, needed KaiOS/hardware-D-pad
    // behavior — left untouched. But #topbar-accept (>240px touchscreen UI)
    // showing it is a pure artifact: showPanel() auto-focuses the first
    // diary row whenever one exists (since #btn-diary-add-food is hidden at
    // this width), with no visible highlight to explain why (the highlight
    // itself stays hidden until an arrow key is actually pressed — see
    // list.css). It's also just redundant there regardless — tapping a row
    // already opens Servings directly, so this button has no real job on
    // Diary at all.
    document.getElementById('topbar-accept').classList.add('topbar-btn-empty');
  } else if (panel.id === 'panel-search') {
    if (state.searchMode === 'recipe-ingredient') {
      setSoftkeys('Back', 'Select', '');
    } else {
      var label = state.tray.length ? ('Add (' + (state.tray.length + 1) + ')') : 'Add';
      setSoftkeys('Back', label, 'Tray');
    }
  } else if (panel.id === 'panel-servings') {
    if (state.servingsMode === 'diary') {
      setSoftkeys('Back', 'Save', 'Delete');
    } else {
      setSoftkeys('Back', 'Add', '');
    }
  } else if (panel.id === 'panel-new-food') {
    var onSubmitBtn = isNewFoodSubmitBtn(focused());
    setSoftkeys('Back', onSubmitBtn ? 'Submit' : 'Next', '');
  } else if (panel.id === 'panel-recipe-builder') {
    var onRecipeSubmit = focused() && focused().id === 'btn-recipe-submit';
    setSoftkeys('Back', onRecipeSubmit ? 'Save Recipe' : 'Next', '');
  } else if (panel.id === 'panel-guesstimate') {
    var onGuessSubmit = focused() && focused().id === 'btn-guesstimate-submit';
    setSoftkeys('Back', onGuessSubmit ? 'Add' : 'Next', '');
  } else if (panel.id === 'panel-scan') {
    setSoftkeys('Cancel', '', '');
  } else if (panel.id === 'panel-scan-result') {
    // 'Select' only makes sense while focus is on a row/button (a match
    // result or "+ Create new food") — blank while typing into either text
    // field, same reasoning New Food's dynamic Next/Submit label uses for
    // "only show an action label when the focused control actually has one".
    setSoftkeys('Back', isTextInput(focused()) ? '' : 'Select', '');
  } else if (panel.id === 'panel-options') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-login-email') {
    setSoftkeys('Back', 'Next', '');
  } else if (panel.id === 'panel-login-otp') {
    setSoftkeys('Back', 'Verify', '');
  } else if (panel.id === 'panel-my-foods') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-my-recipes') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-foods-recipes') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-meals') {
    setSoftkeys('Back', 'SELECT', '');
  } else if (panel.id === 'panel-meal-edit') {
    setSoftkeys('Back', 'Save', '');
  }
}

// ─── D-pad Navigation ─────────────────────────────────────────────────────────

function activePanel() {
  return document.querySelector('.panel[active="true"]');
}

// offsetParent is null for anything with display:none (itself or an
// ancestor) — cheap, standard "is this actually rendered" check. Needed
// since #btn-scan-upc (see css/header.css's >240px .header-action-btn
// gating) is the first nav-selectable element in the app that's ever
// conditionally hidden like this; every other one is always visible
// whenever its panel is active, so this doesn't change their behavior.
function isVisible(el) {
  return el.offsetParent !== null;
}

function selectables() {
  if (isSheetOpen()) {
    return Array.prototype.slice.call(document.querySelectorAll('#sheet [nav-selectable="true"]')).filter(isVisible);
  }
  var panel = activePanel();
  if (!panel) return [];
  return Array.prototype.slice.call(panel.querySelectorAll('[nav-selectable="true"]')).filter(isVisible);
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

// A mouse/touch click on a real form control moves the browser's own focus
// there, but not nav-selected (the "virtual cursor" Enter/center-key
// advancement reads via focused()) — those are independent, and only
// setFocus() (i.e. keyboard-driven navigation) ever touches nav-selected.
// Without this, clicking around and then pressing Enter advances from
// wherever nav-selected last was (e.g. the last field reached via
// keyboard), not the field actually clicked. Delegated on 'focusin'
// (bubbles, fires for any real focus change, not just a direct click —
// covers Tab, programmatic .focus(), etc. too) rather than 'click' so it
// stays correct regardless of how a field ends up focused.
//
// Deliberately does NOT call el.focus() the way setFocus() does — real
// focus is already exactly where it needs to be, that's what triggered
// this — and for a wrapped control (wireFocusForwardingWrapper: the
// wrapper div is nav-selectable, not the inner <select>/date input),
// calling .focus() on the wrapper here would yank real focus back off the
// control the user just interacted with.
document.addEventListener('focusin', function (e) {
  var target = e.target && e.target.closest ? e.target.closest('[nav-selectable="true"]') : null;
  if (!target || target === focused()) return;
  var prev = focused();
  if (prev) prev.removeAttribute('nav-selected');
  target.setAttribute('nav-selected', 'true');
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
  scrollToVisible(target);
  updateSoftkeysForFocus();
});

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
    if (state.searchMode === 'recipe-ingredient') {
      resumeRecipeBuilderPanel();
    } else {
      state.tray = [];
      showDiaryPanel();
    }
  } else if (panel.id === 'panel-servings') {
    if (state.servingsMode === 'recipe-ingredient') {
      resumeRecipeBuilderPanel();
    } else if (state.servingsMode === 'diary-add') {
      var cancelled = state.pendingDiaryAdd;
      state.pendingDiaryAdd = null;
      showDiaryPanel();
      if (cancelled && cancelled.onCancel) cancelled.onCancel();
    } else {
      showDiaryPanel();
    }
  } else if (panel.id === 'panel-new-food') {
    returnToSearchPanel();
  } else if (panel.id === 'panel-recipe-builder') {
    // Editing an existing recipe was reached from My Recipes, not Search —
    // Back should return there, not to a Search screen never actually visited.
    if (state.recipeBuilder && state.recipeBuilder.editingId) showMyRecipesPanel();
    else returnToSearchPanel();
  } else if (panel.id === 'panel-guesstimate') {
    returnToSearchPanel();
  } else if (panel.id === 'panel-scan') {
    closeScanPanel();
  } else if (panel.id === 'panel-scan-result') {
    returnToSearchPanel();
  } else if (panel.id === 'panel-options') {
    showDiaryPanel();
  } else if (panel.id === 'panel-login-email') {
    showOptionsPanel();
  } else if (panel.id === 'panel-login-otp') {
    showLoginEmailPanel();
  } else if (panel.id === 'panel-my-foods') {
    if (state.myFoodsBackTo === 'foods-recipes') showFoodsRecipesPanel();
    else showOptionsPanel();
  } else if (panel.id === 'panel-my-recipes') {
    if (state.myFoodsBackTo === 'foods-recipes') showFoodsRecipesPanel();
    else showOptionsPanel();
  } else if (panel.id === 'panel-foods-recipes') {
    showDiaryPanel();
  } else if (panel.id === 'panel-meals') {
    showOptionsPanel();
  } else if (panel.id === 'panel-meal-edit') {
    showMealsPanel();
  }
  // panel-diary: no left-softkey action
}

function handleSoftRight() {
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-diary') {
    showOptionsPanel();
  } else if (panel.id === 'panel-search') {
    if (state.searchMode !== 'recipe-ingredient') addFocusedToTray();
  } else if (panel.id === 'panel-servings') {
    if (state.servingsMode === 'diary') deleteCurrentEntry();
  }
  // panel-options: no right-softkey action
}

// Shared by #sk-center's click AND #topbar-accept (the >240px touchscreen
// UI's equivalent, see index.html) — extracted so both call sites dispatch
// through one place rather than duplicating this per-panel switch.
function handleSoftCenter() {
  if (isSheetOpen()) { interact(focused()); return; }
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-search') {
    var food = getFocusedFood();
    if (!food) { showStatus('Select a food first', true); return; }
    if (state.searchMode === 'recipe-ingredient') showRecipeIngredientQtyPanel(food);
    else commitFoodAndTray(food);
  } else if (panel.id === 'panel-servings') {
    servingsCenterAction();
  } else if (panel.id === 'panel-new-food') {
    newFoodCenterAction();
  } else if (panel.id === 'panel-recipe-builder') {
    recipeBuilderCenterAction();
  } else if (panel.id === 'panel-guesstimate') {
    guesstimateCenterAction();
  } else if (panel.id === 'panel-login-email') {
    submitLoginEmail();
  } else if (panel.id === 'panel-login-otp') {
    submitLoginOtp();
  } else if (panel.id === 'panel-meal-edit') {
    saveMealEdit();
  } else {
    interact(focused());
  }
}

// Shared by #sk-left's click AND #topbar-back — same isSheetOpen() special
// case both need (Back should close an open sheet rather than act on
// whatever panel is behind it).
function handleTopLeftAction() {
  if (isSheetOpen()) { closeSheet(); } else { handleSoftLeft(); }
}

document.getElementById('sk-left').addEventListener('click', handleTopLeftAction);
document.getElementById('sk-right').addEventListener('click', handleSoftRight);
document.getElementById('sk-center').addEventListener('click', handleSoftCenter);
document.getElementById('topbar-back').addEventListener('click', handleTopLeftAction);
document.getElementById('topbar-accept').addEventListener('click', handleSoftCenter);
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

// createdAt is only set going forward (see buildDiaryEntry/submitGuesstimate)
// — an entry from before this field existed falls back to `updated` (still
// accurate for one that's never been edited since) and then to the local
// autoincrement `id` as a last resort for a genuinely field-less record.
function diaryEntryAddedAt(entry) {
  return entry.createdAt || entry.updated || entry.id || 0;
}

function buildDiaryRow(entry) {
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
  return li;
}

// Buckets entries into getMeals()'s order, plus a trailing "Other" group for
// anything with no mealId or one pointing at a since-deleted meal — the
// same check covers both cases for free, no cleanup pass needed anywhere
// when a meal gets deleted (see deleteMeal). Empty groups aren't rendered.
function renderDiaryGrouped(ul, entries) {
  var meals = getMeals();
  var validIds = {};
  meals.forEach(function (m) { validIds[m.id] = true; });
  var byMeal = {};
  meals.forEach(function (m) { byMeal[m.id] = []; });
  var other = [];
  entries.forEach(function (e) {
    if (e.mealId && validIds[e.mealId]) byMeal[e.mealId].push(e);
    else other.push(e);
  });
  meals.forEach(function (m) { appendDiaryGroup(ul, m.name, byMeal[m.id]); });
  appendDiaryGroup(ul, 'Other', other);
}

function appendDiaryGroup(ul, label, groupEntries) {
  if (!groupEntries.length) return;
  var header = document.createElement('li');
  header.className = 'diary-group-header';

  var name = document.createElement('span');
  name.className = 'diary-group-header-name';
  name.textContent = label;

  var totalCalories = groupEntries.reduce(function (sum, e) { return sum + (e.calories || 0); }, 0);
  var total = document.createElement('span');
  total.className = 'diary-group-header-calories';
  total.textContent = Math.round(totalCalories) + ' cal';

  header.appendChild(name);
  header.appendChild(total);
  ul.appendChild(header);
  groupEntries.forEach(function (entry) { ul.appendChild(buildDiaryRow(entry)); });
}

function renderDiary(callback) {
  dbGetDiaryByDate(state.currentDate, function (rawEntries) {
    // Tombstoned entries stay in IndexedDB (see dbSoftDeleteDiaryEntry) so a
    // later sync can report the deletion — they're just never shown.
    var entries = rawEntries.filter(function (e) { return e.deleted !== true; })
      .sort(function (a, b) { return diaryEntryAddedAt(a) - diaryEntryAddedAt(b); });
    state.diaryEntries = entries;
    var ul = document.getElementById('diary-ul');
    ul.innerHTML = '';
    document.getElementById('diary-empty').style.display = entries.length ? 'none' : 'block';

    if (getMealsEnabled()) renderDiaryGrouped(ul, entries);
    else entries.forEach(function (entry) { ul.appendChild(buildDiaryRow(entry)); });

    renderDiarySummary(entries);
    if (callback) callback();
  });
}

// The single place that decides which macros show up and how they're
// formatted — shared by the Diary/Servings/Recipe summary tables (`prefix`
// is 'sum'/'serv'/'recipe', matching each panel's `#{prefix}-{key}` id
// convention). Adding a macro in the future is just SUMMARY_KEYS + the 3
// HTML rows, not 3 separate render functions each reimplementing this loop.
function renderMacroSummary(prefix, values) {
  SUMMARY_KEYS.forEach(function (k) {
    var el = document.getElementById(prefix + '-' + k);
    if (el) el.textContent = Math.round(values[k] || 0);
  });
}

function renderDiarySummary(entries) {
  var totals = {};
  SUMMARY_KEYS.forEach(function (k) { totals[k] = 0; });
  entries.forEach(function (e) {
    SUMMARY_KEYS.forEach(function (k) { totals[k] += (e[k] || 0); });
  });
  renderMacroSummary('sum', totals);
}

// ─── Screen: Search ───────────────────────────────────────────────────────────

function showSearchPanel() {
  state.searchMode = 'diary';
  state.tray = [];
  showPanel('panel-search');
  document.getElementById('input-search').value = '';
  renderSearchResults('');
  setSoftkeys('Back', 'Add', 'Tray');
}

// Picking a food to add as a recipe ingredient instead of logging it — see
// showRecipeIngredientQtyPanel(), which is where picking a result actually
// goes in this mode instead of committing straight to the diary.
function showSearchPanelForRecipeIngredient() {
  state.searchMode = 'recipe-ingredient';
  state.tray = [];
  showPanel('panel-search');
  document.getElementById('input-search').value = '';
  renderSearchResults('');
  setSoftkeys('Back', 'Select', '');
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

// ─── Remote catalog search (/search) ────────────────────────────────────────
// Independent from the 150ms local-search debounce above — a much longer
// (500ms) pause-based debounce, plus a hard single-flight guard, since this
// hits a Lambda searching a 455K-row file rather than the small in-memory
// local catalog. searchInProgress is never used to cancel/abort an in-flight
// call — only to skip *starting* a new one while one is still outstanding.
// If the debounce fires again mid-flight, that trigger is simply dropped;
// the user accepted that tradeoff for bounded, predictable load on the
// endpoint over guaranteeing every keystroke's final query gets searched.
var _remoteSearchDebounce = null;
var searchInProgress = false;

document.getElementById('input-search').addEventListener('input', function (e) {
  var q = e.target.value;
  clearTimeout(_remoteSearchDebounce);
  _remoteSearchDebounce = setTimeout(function () { triggerRemoteSearch(q); }, 500);
});

function triggerRemoteSearch(rawQuery) {
  if (searchInProgress) return; // one already in flight — drop this trigger, don't queue it
  // No ingredient-picker equivalent of the scan/UPC "hit" flow below (it
  // always commits straight to the diary) — remote search only makes sense
  // for the normal add-to-diary search.
  if (state.searchMode === 'recipe-ingredient') return;
  var q = rawQuery.trim();
  if (!q) return;

  searchInProgress = true;
  xhrPostJson(SEARCH_URL, { query: q })
    .then(function (res) {
      var results = (res.status === 200 && Array.isArray(res.data)) ? res.data : [];
      renderRemoteSearchResults(q, results);
    })
    .catch(function () {
      // Network hiccup — non-fatal, just no remote rows this time.
    })
    .then(function () {
      // Released once this call has settled either way (rendered, discarded
      // as stale, or errored) — never only on a successful render, or a
      // single stale/failed response would leave every future remote search
      // permanently blocked.
      searchInProgress = false;
    });
}

// Async by the time this runs (500ms debounce + a network round trip), so
// #search-ul may have been fully rebuilt by the 150ms local-search debounce
// one or more times since this request went out — same staleness-guard
// idiom renderUpcSearchResult/resolveRemoteUpcLookup already use elsewhere
// in this file (re-check the live query/panel before touching the DOM).
function renderRemoteSearchResults(query, results) {
  if (document.getElementById('input-search').value.trim() !== query) return;
  var panel = activePanel();
  if (!panel || panel.id !== 'panel-search') return;
  var anchor = document.getElementById('search-add-new-food');
  if (!anchor) return;

  var ul = document.getElementById('search-ul');
  results.forEach(function (r) {
    var li = document.createElement('li');
    li.className = 'search-row';
    li.setAttribute('nav-selectable', 'true');
    var nameSpan = document.createElement('span');
    nameSpan.textContent = r.name;
    var tag = document.createElement('span');
    tag.className = 'recipe-tag';
    tag.textContent = 'Catalog';
    li.appendChild(nameSpan);
    li.appendChild(tag);
    // Only a name+UPC pointer, not a full food record — same entry point a
    // real barcode scan or manually-typed UPC uses (local-mapping check,
    // then remote /lookup-upc, auto-add on a hit or "Barcode not found").
    li.addEventListener('click', function () { handleScannedUpc([r.upc]); });
    ul.insertBefore(li, anchor);
  });
}

function renderSearchResults(query) {
  var ul = document.getElementById('search-ul');
  ul.innerHTML = '';
  var q = normalizeForSearch(query.trim());
  var pickingIngredient = state.searchMode === 'recipe-ingredient';
  var results = q ? state.allFoods.filter(function (f) {
    if (f.deleted === true) return false;
    // A recipe can't be an ingredient of another recipe — keeps nutrition
    // baked-in-once at each level, no chained/nested recompute chains.
    if (pickingIngredient && f.type === 'recipe') return false;
    return normalizeForSearch(f.name).indexOf(q) !== -1;
  }).sort(function (a, b) {
    var countA = state.usageCounts[a.id] || 0;
    var countB = state.usageCounts[b.id] || 0;
    if (countB !== countA) return countB - countA; // most-used first
    return a.name.localeCompare(b.name);            // then alphabetical
  }) : [];
  // Unbounded — full result set is rendered as DOM rows below. Revisit with
  // a .slice(0, N) cap here if broad queries cause visible lag/nav slowdown
  // on-device.

  results.forEach(function (food) {
    var li = document.createElement('li');
    li.className = 'search-row' + (trayHasFood(food.id) ? ' in-tray' : '');
    li.setAttribute('nav-selectable', 'true');
    li.setAttribute('data-food-id', food.id);
    if (food.type === 'recipe') {
      var nameSpan = document.createElement('span');
      nameSpan.textContent = food.name;
      var tag = document.createElement('span');
      tag.className = 'recipe-tag';
      tag.textContent = 'Recipe';
      li.appendChild(nameSpan);
      li.appendChild(tag);
    } else {
      li.textContent = food.name;
    }
    li.addEventListener('click', function () {
      if (pickingIngredient) showRecipeIngredientQtyPanel(food);
      else commitFoodAndTray(food);
    });
    ul.appendChild(li);
  });

  // Always the last rows, even with an empty query (i.e. visible the
  // moment Search opens, not just once you start typing) — whether there
  // are 0 or 50 real matches above them. Not shown while picking a recipe
  // ingredient — a guesstimate has no food record to pick as an ingredient,
  // and nesting the recipe builder inside itself isn't supported.
  if (!pickingIngredient) {
    // A 12-14 digit query is never going to substring-match a food name, so
    // this UPC carried through to a blank "+ Add new food" doesn't collide
    // with anything above — it's just extra context, not the food's name.
    var upcQuery = /^\d{12,14}$/.test(query.trim()) ? query.trim() : null;

    var addNew = document.createElement('li');
    addNew.id = 'search-add-new-food'; // anchor for renderRemoteSearchResults' async insertBefore
    addNew.className = 'search-row add-new';
    addNew.setAttribute('nav-selectable', 'true');
    addNew.textContent = '+ Add new food';
    addNew.addEventListener('click', function () {
      showNewFoodPanel(upcQuery ? { name: '', upc: upcQuery } : query.trim());
    });
    ul.appendChild(addNew);

    var addRecipe = document.createElement('li');
    addRecipe.className = 'search-row add-new-recipe';
    addRecipe.setAttribute('nav-selectable', 'true');
    addRecipe.textContent = '+ Add new recipe';
    addRecipe.addEventListener('click', function () { showRecipeBuilderPanel(query.trim()); });
    ul.appendChild(addRecipe);

    var addGuess = document.createElement('li');
    addGuess.className = 'search-row add-new-guesstimate';
    addGuess.setAttribute('nav-selectable', 'true');
    addGuess.textContent = '+ Add guesstimate';
    addGuess.addEventListener('click', function () { showGuesstimatePanel(query.trim()); });
    ul.appendChild(addGuess);

    // UPC lookup is async (IndexedDB, then maybe a network call) — it
    // inserts its own row(s) at the very top of #search-ul once it
    // resolves, on top of everything rendered synchronously above.
    if (upcQuery) renderUpcSearchResult(upcQuery);
  }
}

// Shared by renderUpcSearchResult (manual UPC typed into Search) and
// handleScannedUpc (a camera scan) — both need the identical "is this UPC
// already mapped to a food we actually have locally" check. A mapping that
// points at a food that hasn't synced locally yet (rare: mapping and
// catalog files synced at different times) does NOT count as a hit — pure
// local check, no network call at all.
function resolveLocalUpcMapping(upc, callback) {
  dbGetUpcMapping(upc, function (mapping) {
    var food = mapping ? state.foodsById[mapping.foodId] : null;
    callback(mapping && food ? { food: food, servingName: mapping.servingName, servingQuantity: mapping.servingQuantity } : null);
  });
}

// Local UPC-mapping lookup first (no network call at all — per spec,
// "nothing will happen on the backend" for an already-known mapping), the
// remote product database only if that misses. Both branches guard against
// a stale response landing after the user's kept typing by re-checking the
// search input's current value before touching the DOM.
function renderUpcSearchResult(upc) {
  resolveLocalUpcMapping(upc, function (hit) {
    if (document.getElementById('input-search').value.trim() !== upc) return;

    if (hit) {
      insertUpcResultRow(hit.food.name + ' — ' + formatQty(hit.servingQuantity) + ' ' + hit.servingName, function () {
        commitUpcMappedFoodToDiary(hit.food, hit.servingName, hit.servingQuantity);
      });
      return;
    }

    // No local mapping — or one exists but points at a food that hasn't
    // synced locally yet (rare: mapping and catalog files synced at
    // different times). Either way, fall through to the remote lookup
    // rather than dead-end.
    xhrPostJson(LOOKUP_UPC_URL, { upc: upc }).then(function (res) {
      if (document.getElementById('input-search').value.trim() !== upc) return;
      if (res.status !== 200 || !res.data) return; // 404/error — the standard "+ Add new food" row already covers it
      var lookupFood = res.data;

      var useRow = insertUpcResultRow(lookupFood.name, function () {
        autoCreateFoodFromUpcLookup(upc, lookupFood);
      });

      var createLi = document.createElement('li');
      createLi.className = 'search-row add-new';
      createLi.setAttribute('nav-selectable', 'true');
      createLi.textContent = '+ Create new food using this UPC';
      createLi.addEventListener('click', function () {
        showNewFoodPanel({ name: lookupFood.name, upc: upc, servings: lookupFood.servings });
      });
      useRow.insertAdjacentElement('afterend', createLi);
    }).catch(function () {
      // Network hiccup — non-fatal, just no UPC-specific rows this time.
    });
  });
}

// Prepended to #search-ul (ahead of the name-search results and CTA rows
// already rendered synchronously) — returns the new <li> so callers can
// position anything else relative to it. Reuses .recipe-tag's badge look
// for a "UPC" tag; the label carries the food name (+ resolved serving,
// when known from a local mapping — a raw remote lookup only ever has the
// name, no chosen serving yet).
function insertUpcResultRow(label, onClick) {
  var ul = document.getElementById('search-ul');
  var li = document.createElement('li');
  li.className = 'search-row';
  li.setAttribute('nav-selectable', 'true');
  var nameSpan = document.createElement('span');
  nameSpan.textContent = label;
  var tag = document.createElement('span');
  tag.className = 'recipe-tag';
  tag.textContent = 'UPC';
  li.appendChild(nameSpan);
  li.appendChild(tag);
  li.addEventListener('click', onClick);
  ul.insertBefore(li, ul.firstChild);
  return li;
}

// ─── Barcode scanning (Search panel's scan button) ─────────────────────────
//
// Uses the same vendored ZXing build as s3/admin.html/s3/barcode-test.html
// (js/vendor/zxing.min.js), hinted to the same barcode symbologies actual
// grocery products use. Unproven on real KaiOS Gecko hardware — admin.html's
// own camera code deliberately targets modern browsers only (see xhrGetJson's
// comment above on Gecko 84's fetch()/Origin-header bug) — so this fails to
// a visible on-screen error rather than a silent dead button if getUserMedia
// or ZXing itself isn't available.
var scanCodeReader = null;

function getScanCodeReader() {
  if (scanCodeReader) return scanCodeReader;
  var hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8
  ]);
  scanCodeReader = new ZXing.BrowserMultiFormatReader(hints);
  return scanCodeReader;
}

// Standard UPC-A check digit (mod-10, 3x-weighted odd positions, 0-indexed
// from the left) — computed fresh rather than trusted from a scan result,
// since exactly how many digits ZXing's UPC_E getText() includes isn't
// something to gamble on (see expandUpcEToUpcA below).
function upcACheckDigit(digits11) {
  var sum = 0;
  for (var i = 0; i < 11; i++) {
    sum += (digits11.charCodeAt(i) - 48) * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

// Standard UPC-E -> UPC-A expansion (the GS1 zero-suppression algorithm).
// Accepts whatever ZXing's UPC_E result text turns out to be — 6 digits
// (just the compressed code), 7 (number-system digit + compressed code), or
// 8 (+ a trailing check digit) — the check digit, if present, is ignored
// and recomputed instead of trusted, for the same reason as above.
function expandUpcEToUpcA(upcE) {
  var ns = upcE.length >= 7 ? upcE.charAt(0) : '0';
  var d = upcE.length >= 7 ? upcE.substr(upcE.length - 7, 6) : upcE.substr(0, 6);
  var mid;
  switch (d.charAt(5)) {
    case '0': case '1': case '2':
      mid = d.slice(0, 2) + d.charAt(5) + '0000' + d.slice(2, 5);
      break;
    case '3':
      mid = d.slice(0, 3) + '00000' + d.slice(3, 5);
      break;
    case '4':
      mid = d.slice(0, 4) + '00000' + d.charAt(4);
      break;
    default:
      mid = d.slice(0, 5) + '0000' + d.charAt(5);
  }
  var digits11 = ns + mid;
  return digits11 + upcACheckDigit(digits11);
}

// Barcode-format-aware candidate list for a scanned code, most-preferred
// first. A UPC_E scan always expands to exactly one UPC-A candidate. An
// EAN_13 starting with '0' is tried as both the literal 13-digit scan AND
// the 12-digit UPC-A it's equivalent to (dropping the leading zero) — this
// app's own UPC data is 12-digit-UPC-centric (backend/lambda/calorie_api/
// upc.py's _normalize_upc only ever pads a short code up to 12 digits,
// never trims a longer one down), so a product whose barcode happened to be
// printed/scanned as EAN-13 would otherwise silently miss every lookup.
// Everything else (UPC_A, EAN_8, an EAN_13 not starting with '0') is just
// the one literal scanned value, unchanged.
function upcLookupCandidates(code, format) {
  if (format === ZXing.BarcodeFormat.UPC_E) return [expandUpcEToUpcA(code)];
  if (format === ZXing.BarcodeFormat.EAN_13 && code.length === 13 && code.charAt(0) === '0') {
    return [code, code.substr(1)];
  }
  return [code];
}

function showScanPanel() {
  document.getElementById('scan-error').textContent = '';
  showPanel('panel-scan');

  if (typeof ZXing === 'undefined') {
    document.getElementById('scan-error').textContent = 'Barcode scanning is not available on this device.';
    return;
  }

  var reader = getScanCodeReader();
  reader.decodeFromConstraints(
    { audio: false, video: { facingMode: { ideal: 'environment' } } },
    document.getElementById('scan-video'),
    function (result, err) {
      if (result) {
        stopScanCamera();
        handleScannedUpc(upcLookupCandidates(result.getText(), result.getBarcodeFormat()));
        return;
      }
      // NotFoundException just means no barcode was in this particular
      // frame — expected on nearly every frame while aiming the camera,
      // not a real error.
      if (err && !(err instanceof ZXing.NotFoundException)) {
        document.getElementById('scan-error').textContent = 'Scan error: ' + err.message;
      }
    }
  ).catch(function (err) {
    document.getElementById('scan-error').textContent = 'Could not access camera: ' + err.message;
  });
}

function stopScanCamera() {
  if (scanCodeReader) scanCodeReader.reset();
}

function closeScanPanel() {
  stopScanCamera();
  returnToSearchPanel();
}

document.getElementById('btn-scan-upc').addEventListener('click', showScanPanel);
document.getElementById('btn-scan-cancel').addEventListener('click', closeScanPanel);

// Requirement: an already-known local mapping whose food has actually
// synced locally (state.foodsById resolves it) keeps the exact one-tap
// behavior scanning already had — commitUpcMappedFoodToDiary, no panel, no
// extra taps. Every other case (no mapping at all, or a mapping whose food
// hasn't synced down yet) opens the Scan Result panel instead of the old
// "fill the search bar" detour. `candidates` (see upcLookupCandidates) is
// tried in order — a UPC-E/EAN-13 scan may need to check more than one
// equivalent code before concluding there's no local mapping at all.
function handleScannedUpc(candidates) {
  tryLocalUpcCandidates(candidates, 0);
}

function tryLocalUpcCandidates(candidates, i) {
  if (i >= candidates.length) {
    showScanResultPanel(candidates);
    return;
  }
  resolveLocalUpcMapping(candidates[i], function (hit) {
    if (hit) {
      commitUpcMappedFoodToDiary(hit.food, hit.servingName, hit.servingQuantity);
    } else {
      tryLocalUpcCandidates(candidates, i + 1);
    }
  });
}

// ─── Screen: Scan Result ────────────────────────────────────────────────────
//
// Reached only from handleScannedUpc when a scanned UPC has no already-
// resolved local mapping AND no /lookup-upc hit either — a hit is applied
// immediately (see resolveRemoteUpcLookup below), exactly as if the user
// had confirmed it themselves, so this panel only ever represents the
// "barcode not found" case. Two things live here: (a) the scanned code
// itself, editable in case of a misread digit; (b) a live search over
// state.allFoods to match this barcode to an existing food (mirrors
// #input-search/renderSearchResults); (c) a shortcut into New Food,
// prefilled with just the UPC. The UPC field is deliberately not re-looked-
// up on edit — an edited value only ever affects what gets sent by (b) and
// (c) below.

// `candidates` (see upcLookupCandidates) — the field is prefilled with the
// first/most-preferred candidate (still fully editable), and the remote
// lookup below tries every candidate in turn, not just that first one.
function showScanResultPanel(candidates) {
  document.getElementById('input-scan-upc').value = candidates[0];
  document.getElementById('scan-lookup-result').textContent = 'Looking up product…';
  document.getElementById('input-scan-match-search').value = '';
  renderScanMatchResults('');
  showPanel('panel-scan-result');
  resolveRemoteUpcLookup(candidates, 0);
}

// A hit here is applied immediately via autoCreateFoodFromUpcLookup — the
// same one-tap add already used for a UPC typed directly into the main
// Search box (renderUpcSearchResult) — rather than making the user confirm
// a match they just scanned. Only once every candidate has missed (no hit,
// or a hit with no usable servings) does the panel surface as "Barcode not
// found".
function resolveRemoteUpcLookup(candidates, i) {
  if (i >= candidates.length) {
    var panel = activePanel();
    if (panel && panel.id === 'panel-scan-result') {
      document.getElementById('scan-lookup-result').textContent = 'Barcode not found';
    }
    return;
  }
  xhrPostJson(LOOKUP_UPC_URL, { upc: candidates[i] }).then(function (res) {
    // Guards against a stale response landing after the panel's been left
    // (e.g. user hit Back while the request was in flight) — same
    // "re-check before touching the DOM" pattern renderUpcSearchResult uses.
    var panel = activePanel();
    if (!panel || panel.id !== 'panel-scan-result') return;
    var hit = res.status === 200 && res.data && res.data.servings && res.data.servings.length;
    if (hit) {
      autoCreateFoodFromUpcLookup(candidates[i], res.data);
    } else {
      resolveRemoteUpcLookup(candidates, i + 1);
    }
  }).catch(function () {
    resolveRemoteUpcLookup(candidates, i + 1);
  });
}

var _scanMatchDebounce = null;
document.getElementById('input-scan-match-search').addEventListener('input', function (e) {
  var q = e.target.value;
  clearTimeout(_scanMatchDebounce);
  _scanMatchDebounce = setTimeout(function () { renderScanMatchResults(q); }, 150);
});

// Mirrors renderSearchResults' filtering/sorting exactly but with no CTA
// rows and no tray — this list exists purely to pick one food to map the
// barcode to. Recipes are excluded: a UPC identifies a packaged product,
// and a recipe is a personal combo-food snapshot, not something another
// shopper's barcode should ever resolve to (same exclusion
// renderSearchResults already applies while picking a recipe ingredient).
function renderScanMatchResults(query) {
  var ul = document.getElementById('scan-match-ul');
  ul.innerHTML = '';
  var q = normalizeForSearch(query.trim());
  var results = q ? state.allFoods.filter(function (f) {
    if (f.deleted === true) return false;
    if (f.type === 'recipe') return false;
    return normalizeForSearch(f.name).indexOf(q) !== -1;
  }).sort(function (a, b) {
    var countA = state.usageCounts[a.id] || 0;
    var countB = state.usageCounts[b.id] || 0;
    if (countB !== countA) return countB - countA;
    return a.name.localeCompare(b.name);
  }) : [];

  results.forEach(function (food) {
    var li = document.createElement('li');
    li.className = 'search-row';
    li.setAttribute('nav-selectable', 'true');
    li.textContent = food.name;
    li.addEventListener('click', function () { openScanMatchServingSheet(food); });
    ul.appendChild(li);
  });

  document.getElementById('scan-match-empty').style.display = (q && !results.length) ? 'block' : 'none';
}

// Picking which serving this barcode matches — a bottom sheet (the app's
// existing "pick one of a few options" primitive), not a new panel/inline
// expansion. No custom quantity entry here — the mapping always uses one of
// the food's real, already-defined servings as-is.
function openScanMatchServingSheet(food) {
  var upc = document.getElementById('input-scan-upc').value.trim();
  var items = (food.servings || []).map(function (serving) {
    return {
      label: formatQty(serving.quantity) + ' ' + serving.name + ' — ' + Math.round(serving.calories || 0) + ' cal',
      action: function () {
        closeSheet();
        commitMatchedFoodToDiaryAndProposeMapping(food, serving, upc);
      }
    };
  });
  openSheet(items, { title: food.name, note: 'Select the serving this barcode matches' });
}

// Picking a food+serving here does BOTH — adds it to today's diary
// immediately (same UX as the existing fast-path/lookup-hit flows: diary
// panel, "Added X" toast, syncAfterDiaryMutation) AND submits a pending
// UPC-mapping proposal to the backend. The two effects are independent and
// don't block each other — the diary add is the user-visible,
// always-succeeds-locally part; the mapping submission is best-effort/
// non-blocking, same philosophy as submitNewFoodToApi. Reuses
// addFoodToDiaryWithServing exactly as commitUpcMappedFoodToDiary already
// does.
function commitMatchedFoodToDiaryAndProposeMapping(food, serving, upc) {
  gateOrAddToDiary(food, serving.name, serving.quantity, function () {
    showDiaryPanel();
    showStatus('Added ' + food.name, false);
    syncAfterDiaryMutation();
    // Only proposed once the entry is actually committed — if the add-time
    // confirmation gets cancelled, nothing was matched after all.
    if (upc) submitUpcMappingProposal(upc, food.id, food.name, serving.name, serving.quantity);
  });
}

// This panel is only ever reached on a total miss (see showScanResultPanel/
// resolveRemoteUpcLookup above), so there's never lookup data to prefill
// from — identical prefill shape to the blank "+ Add new food" row
// (renderSearchResults) elsewhere, just with the UPC carried over.
document.getElementById('btn-scan-create-new-food').addEventListener('click', function () {
  var upc = document.getElementById('input-scan-upc').value.trim();
  showNewFoodPanel({ name: '', upc: upc });
});

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

function addFoodToDiaryDefault(food, callback, mealId) {
  var def = defaultServingForFood(food);
  var entry = buildDiaryEntry(food, def.serving, def.quantity, mealId);
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
  commitDiaryBatch(items, 0, 0);
}

// Sequential, not the parallel forEach this used to be — required once a
// mid-batch confirmation panel (gateOrAddToDiary, when Meals+Require are
// both on) can interrupt the sequence; each item's gate must fully resolve
// before the next one opens. When the gate is a no-op (feature off), this
// still ends up committing every item, same as the old parallel version did.
function commitDiaryBatch(items, index, committedCount) {
  if (index >= items.length) { finishDiaryBatch(committedCount); return; }
  gateOrAddToDiary(items[index], null, null,
    function () { commitDiaryBatch(items, index + 1, committedCount + 1); },
    // Backing out mid-batch: keep whatever already committed, drop the
    // rest — never leaves a silent partial state, always reports an
    // accurate count.
    function () { finishDiaryBatch(committedCount); }
  );
}

function finishDiaryBatch(committedCount) {
  showDiaryPanel();
  if (committedCount) {
    showStatus('Added ' + committedCount + (committedCount === 1 ? ' item' : ' items'), false);
    syncAfterDiaryMutation();
  }
}

// Same as addFoodToDiaryDefault, but for a specific, already-known serving
// (resolved from a UPC mapping) rather than deriving one via
// defaultServingForFood — falls back to the food's first serving if the
// named one can't be found (shouldn't normally happen, but a serving
// getting renamed after a mapping was created is possible).
function addFoodToDiaryWithServing(food, servingName, quantity, callback, mealId) {
  var serving = food.servings.filter(function (s) { return s.name === servingName; })[0] || food.servings[0];
  var entry = buildDiaryEntry(food, serving, quantity, mealId);
  dbAddDiaryEntry(entry, function (newId) {
    state.usageCounts[food.id] = (state.usageCounts[food.id] || 0) + 1;
    dbIncrementUsageCount(food.id, function () {
      rememberServing(food.id, serving.name, quantity, function () {
        if (callback) callback(newId);
      });
    });
  });
}

// The "already locally mapped" path from the Search panel's UPC lookup —
// unlike commitFoodAndTray, this bypasses the tray entirely and adds
// exactly one food+serving immediately, since a UPC search hit is a single,
// already-resolved pick rather than part of a multi-item tray session.
function commitUpcMappedFoodToDiary(food, servingName, quantity) {
  gateOrAddToDiary(food, servingName, quantity, function () {
    showDiaryPanel();
    showStatus('Added ' + food.name, false);
    syncAfterDiaryMutation();
  });
}

// Behind-the-scenes equivalent of "Create new food using this UPC" (the New
// Food panel path) — used when a remote UPC lookup result is tapped
// directly instead of reviewed first. Trusts the looked-up servings as-is;
// the resulting submission still goes through the same admin review queue
// as any other (see postSubmitJson's upc param), so bad data never reaches
// the shared catalog unreviewed even though it's usable in this diary
// immediately. Always includes the upc (unlike submitNewFood, where it's
// only sent if the user typed one in) — that's the whole point of this path.
function autoCreateFoodFromUpcLookup(upc, lookupFood) {
  if (!lookupFood.servings || !lookupFood.servings.length) {
    showStatus('That UPC has no usable serving data', true);
    return;
  }

  var id = generateGuid();
  var food = {
    id: id,
    name: lookupFood.name,
    servings: lookupFood.servings,
    source: 'local',
    updated: nowSec(),
    deleted: false
  };

  dbBulkPutFoods([food], function () {
    state.allFoods.push(food);
    state.foodsById[food.id] = food;
    // My Foods must show every locally-created food regardless of login
    // state. Submission itself is anonymous-friendly too, same as
    // submitNewFood — see its own comment for why.
    dbPutMySubmission({ id: id, createdAt: nowSec(), submittedAt: null, submitStatus: 'local' }, function () {
      var primary = food.servings[0];
      gateOrAddToDiary(food, primary.name, primary.quantity, function () {
        submitNewFoodToApi(id, food.name, food.servings, upc);
        showDiaryPanel();
        showStatus('Added ' + food.name, false);
        syncAfterDiaryMutation();
      });
    });
  });
}

// ─── Serving math ─────────────────────────────────────────────────────────────

function buildDiaryEntry(food, servingObj, qty, mealId) {
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
    // When this entry was first logged — unlike `updated`, this is never
    // touched again once set (see saveServingsEdit, which explicitly
    // preserves it across an edit the same way it preserves guid) so the
    // diary can sort by "when I actually added this" rather than "when I
    // last touched it". Travels through /sync/diary like any other field,
    // so it stays accurate even for an entry synced down from another
    // device — see renderDiary's sort.
    createdAt: nowSec(),
    // Which Meals-manager entry this belongs to, or null/undefined for
    // "Other" — see renderDiaryGrouped. Optional trailing param so every
    // pre-existing call site that doesn't pass one is unaffected.
    mealId: mealId || null,
    deleted: false
  };
  Object.keys(servingObj).forEach(function (key) {
    if (key === 'name' || key === 'quantity') return;
    entry[key] = round2(servingObj[key] * scale);
  });
  return entry;
}

// Same shape/scaling as buildDiaryEntry, but for editing an entry with no
// backing food record (every guesstimate) — scales straight off the
// synthesized baseline from currentServingBaseline() instead of a real
// food's serving. E.g. doubling the quantity on a guesstimate scales its
// calorie guess linearly, same as any other entry.
function buildDiaryEntryFromBaseline(entry, baseline, qty) {
  var scale = baseline.quantity ? (qty / baseline.quantity) : 0;
  var updated = {
    date: entry.date,
    foodId: entry.foodId,
    foodName: entry.foodName,
    servingName: baseline.name,
    quantity: qty,
    guid: generateGuid(),
    updated: nowSec(),
    deleted: false
  };
  if (entry.type) updated.type = entry.type;
  Object.keys(baseline).forEach(function (key) {
    if (key === 'name' || key === 'quantity') return;
    updated[key] = round2(baseline[key] * scale);
  });
  return updated;
}

// ─── Screen: Servings ─────────────────────────────────────────────────────────

function showServingsPanel(entry) {
  state.servingsMode = 'diary';
  state.editingEntry = entry;
  state.editingFood = state.foodsById[entry.foodId] || null;

  document.getElementById('btn-servings-delete').classList.remove('mode-hidden');
  showPanel('panel-servings');
  document.getElementById('servings-panel-title').textContent = 'Edit Serving';
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

  // Meal reassignment is always optional here (unlike the add-time
  // confirmation) — you can leave a previously-logged entry unassigned.
  var mealsOn = getMealsEnabled();
  applyMealFieldVisibility('wrap-diary-meal', mealsOn);
  if (mealsOn) populateMealSelect(document.getElementById('input-meal'), entry.mealId, false);

  renderServingsPreview();
  setSoftkeys('Back', 'Save', 'Delete');
}

// When there's a backing food (the normal case), the baseline is one of
// its actual serving definitions. When there isn't — every guesstimate, by
// design, plus any diary entry whose food was later deleted — synthesize a
// baseline straight from the entry's own snapshot, so editing quantity
// still scales it linearly instead of hard-failing.
function currentServingBaseline() {
  if (state.editingFood) {
    var name = document.getElementById('input-serving-name').value;
    return state.editingFood.servings.filter(function (s) { return s.name === name; })[0] || null;
  }
  var entry = state.editingEntry;
  if (!entry) return null;
  var baseline = { name: entry.servingName, quantity: entry.quantity || 1 };
  Object.keys(entry).forEach(function (key) {
    if (NON_NUTRIENT_KEYS.indexOf(key) !== -1) return;
    baseline[key] = entry[key];
  });
  return baseline;
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
  renderMacroSummary('serv', values);
  renderNutrientTable('servings-nutrients', values);
}

// Shared by the Servings panel and the Recipe Builder's live preview — any
// key on `values` that isn't one of the SUMMARY_KEYS macros (calories/fat/
// carbs/protein/caffeine/alcohol, shown separately via renderMacroSummary)
// or a non-nutrient bookkeeping field (id/date/foodId/etc.) gets its own
// row here.
function renderNutrientTable(containerId, values) {
  var container = document.getElementById(containerId);
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
    servingsCenterAction();
  }
});

document.getElementById('input-serving-name').addEventListener('change', renderServingsPreview);

wireFocusForwardingWrapper('wrap-serving-name', 'input-serving-name');
wireFocusForwardingWrapper('wrap-diary-meal', 'input-meal');

function saveServingsEdit() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  if (!baseline) {
    showStatus('Could not save (food data unavailable)', true);
    return;
  }
  var updated = state.editingFood
    ? buildDiaryEntry(state.editingFood, baseline, qty)
    : buildDiaryEntryFromBaseline(state.editingEntry, baseline, qty);
  // Preserve the entry's original guid across an edit — it's the /sync/diary
  // merge key, and a fresh one here would make the server treat this as a
  // brand new entry rather than an update to the existing one. Same for
  // createdAt — buildDiaryEntry/buildDiaryEntryFromBaseline both stamp a
  // fresh one as if this were a new entry, but an edit must never change
  // when the entry was originally added (see renderDiary's sort). Falls
  // back to whatever was just generated only for a pre-existing entry that
  // predates this field.
  updated.guid = state.editingEntry.guid || updated.guid;
  updated.createdAt = state.editingEntry.createdAt || updated.createdAt;
  // Meals off — this entry's mealId (whatever it already was) is left
  // completely untouched, same as every other feature-off no-op elsewhere.
  updated.mealId = getMealsEnabled()
    ? (document.getElementById('input-meal').value || null)
    : (state.editingEntry.mealId || null);
  dbUpdateDiaryEntry(state.editingEntry.id, updated, function () {
    if (!state.editingFood) { showDiaryPanel(); syncAfterDiaryMutation(); return; }
    rememberServing(state.editingFood.id, baseline.name, qty, function () {
      showDiaryPanel();
      syncAfterDiaryMutation();
    });
  });
}

// panel-servings does double duty — editing a diary entry's quantity
// (normal) or picking a quantity/unit for a food being added to a recipe's
// ingredient list (see showRecipeIngredientQtyPanel below). Both the qty
// field's own Enter handler and the #sk-center click table dispatch here
// rather than hardcoding saveServingsEdit(), so a stray Enter while
// building a recipe never accidentally tries to save a nonexistent diary
// entry.
function servingsCenterAction() {
  if (state.servingsMode === 'recipe-ingredient') addServingAsRecipeIngredient();
  else if (state.servingsMode === 'diary-add') commitDiaryAdd();
  else saveServingsEdit();
}

// Reuses panel-servings' qty+unit picker UI for "how much of this food goes
// in the recipe" instead of building a parallel panel — same fields, same
// live preview, just a different destination for the result. No diary
// entry backs this, so state.editingEntry stays null.
function showRecipeIngredientQtyPanel(food) {
  state.servingsMode = 'recipe-ingredient';
  state.editingFood = food;
  state.editingEntry = null;

  document.getElementById('btn-servings-delete').classList.add('mode-hidden');
  showPanel('panel-servings');
  document.getElementById('servings-panel-title').textContent = 'Ingredient Quantity';
  document.getElementById('servings-food-name').textContent = food.name;

  var def = defaultServingForFood(food); // pre-fill with this food's last-used qty/serving, same as adding it normally would
  document.getElementById('input-serving-qty').value = formatQty(def.quantity);

  var select = document.getElementById('input-serving-name');
  select.innerHTML = '';
  food.servings.forEach(function (s) {
    var opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    if (s.name === def.serving.name) opt.selected = true;
    select.appendChild(opt);
  });

  // A recipe ingredient isn't a diary entry — no meal concept applies.
  // Must be explicit: this reuses panel-servings' shared DOM, which would
  // otherwise leak a stale meal picker in from a prior diary/diary-add use.
  applyMealFieldVisibility('wrap-diary-meal', false);

  renderServingsPreview();
  setSoftkeys('Back', 'Add', '');
}

// Opened whenever gateOrAddToDiary() decides confirmation is needed — either
// the mandatory-meal gate (getMealsEnabled() && getRequireMealSelection())
// or "After I add a food… -> Modify servings" (getAfterAddFood()), so the
// meal field below can't assume it's always on/required the way it used to.
// Mirrors showRecipeIngredientQtyPanel's shape — same shared panel/fields,
// no backing diary row (state.editingEntry stays null) — but commits
// straight to the diary via commitDiaryAdd() instead of the recipe builder.
// prefillServingName/prefillQuantity are non-null when the caller already
// resolved a specific serving (UPC paths); null to prefill from
// defaultServingForFood's last-used guess.
function showDiaryAddConfirmPanel(food, prefillServingName, prefillQuantity, onComplete, onCancel) {
  state.servingsMode = 'diary-add';
  state.editingFood = food;
  state.editingEntry = null;
  state.pendingDiaryAdd = { onComplete: onComplete, onCancel: onCancel };

  document.getElementById('btn-servings-delete').classList.add('mode-hidden');
  showPanel('panel-servings');
  document.getElementById('servings-panel-title').textContent = 'Add to Diary';
  document.getElementById('servings-food-name').textContent = food.name;

  var def = prefillServingName
    ? { serving: (food.servings.filter(function (s) { return s.name === prefillServingName; })[0] || food.servings[0]), quantity: prefillQuantity }
    : defaultServingForFood(food);
  document.getElementById('input-serving-qty').value = formatQty(def.quantity);

  var select = document.getElementById('input-serving-name');
  select.innerHTML = '';
  food.servings.forEach(function (s) {
    var opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    if (s.name === def.serving.name) opt.selected = true;
    select.appendChild(opt);
  });

  // Same conditional shape showServingsPanel (edit-entry) already uses —
  // this panel can now open with Meals off, so the meal field can't be
  // unconditionally shown/required any more.
  var mealsOn = getMealsEnabled();
  applyMealFieldVisibility('wrap-diary-meal', mealsOn);
  if (mealsOn) populateMealSelect(document.getElementById('input-meal'), null, getRequireMealSelection());

  renderServingsPreview();
  setSoftkeys('Back', 'Add', '');
}

function commitDiaryAdd() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  if (!baseline || !qty) { showStatus('Enter a quantity', true); return; }
  // Meals off — this select was never populated (see showDiaryAddConfirmPanel
  // above), same "feature off, no-op" treatment saveServingsEdit gives it.
  var mealsOn = getMealsEnabled();
  var mealSelect = document.getElementById('input-meal');
  if (mealsOn && mealSelect.value === '__unset__') { showStatus('Select a meal', true); return; }
  var pending = state.pendingDiaryAdd;
  var mealId = mealsOn ? (mealSelect.value || null) : null;
  addFoodToDiaryWithServing(state.editingFood, baseline.name, qty, function (newId) {
    state.pendingDiaryAdd = null;
    // Deliberately no showDiaryPanel() here — navigation is the caller's
    // call via onComplete, exactly like addFoodToDiaryDefault/
    // addFoodToDiaryWithServing never navigate on their own either. This
    // matters for a multi-item Tray batch: showDiaryPanel()'s render is an
    // async IndexedDB round-trip (see renderDiary), and navigating here
    // unconditionally would race against the next item's confirmation
    // panel opening — the delayed render could land moments later and yank
    // focus back to Diary mid-batch.
    if (pending && pending.onComplete) pending.onComplete(newId);
  }, mealId);
}

function addServingAsRecipeIngredient() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  if (!baseline || !qty) {
    showStatus('Enter a quantity', true);
    return;
  }
  state.recipeBuilder.ingredients.push({
    foodId: state.editingFood.id,
    foodName: state.editingFood.name,
    servingName: baseline.name,
    quantity: qty
  });
  resumeRecipeBuilderPanel();
}

// Shared by deleteCurrentEntry() (panel-servings' right-softkey/Delete
// button) and the >240px touchscreen UI's reveal-then-tap swipe delete on
// diary rows (see wireDiaryRowSwipe below) — `entry` is passed explicitly
// rather than read from state.editingEntry so the swipe gesture (which
// never opens panel-servings at all) can delete straight from the list.
// `callback` runs after the delete/usage-count bookkeeping completes;
// deleteCurrentEntry's own navigation/toast/sync stay in its own wrapper.
function deleteDiaryEntry(entry, callback) {
  var foodId = entry.foodId;
  function afterDelete() {
    // A guesstimate has no backing food (foodId is null) — nothing to
    // decrement. null isn't a valid IndexedDB key at all, so calling
    // dbDecrementUsageCount(null, ...) would throw synchronously rather
    // than just silently no-op.
    if (!foodId) { callback(); return; }
    state.usageCounts[foodId] = Math.max(0, (state.usageCounts[foodId] || 0) - 1);
    dbDecrementUsageCount(foodId, callback);
  }
  // Once this device has ever logged in, deletes become tombstones so a
  // later sync can report them — see dbSoftDeleteDiaryEntry.
  if (getEverLoggedIn()) {
    dbSoftDeleteDiaryEntry(entry, afterDelete);
  } else {
    dbDeleteDiaryEntry(entry.id, afterDelete);
  }
}

function deleteCurrentEntry() {
  if (!state.editingEntry) return;
  deleteDiaryEntry(state.editingEntry, function () {
    showDiaryPanel();
    showStatus('Deleted', false);
    syncAfterDiaryMutation();
  });
}

// >240px touchscreen UI's on-screen equivalent of #sk-right's "Delete"
// softkey (hidden at that width along with the rest of #softkey) — see
// index.html's comment above #btn-servings-delete for the mode-gating.
document.getElementById('btn-servings-delete').addEventListener('click', deleteCurrentEntry);

// ─── Screen: New Food ─────────────────────────────────────────────────────────

var NEW_FOOD_NUMERIC_FIELDS = [
  'input-new-food-serving-qty',
  'input-new-food-calories',
  'input-new-food-fat',
  'input-new-food-carbs',
  'input-new-food-protein'
];

// Two Submit buttons exist on this panel — one right after Protein (the
// fast path for a basic entry), one at the very bottom after the optional
// extra-servings/UPC section (so scrolling down into that doesn't mean
// scrolling all the way back up just to submit). Both do the exact same
// thing, so anywhere the code needs to know "is focus on Submit", it needs
// to check both ids.
function isNewFoodSubmitBtn(el) {
  return !!el && (el.id === 'btn-new-food-submit' || el.id === 'btn-new-food-submit-bottom');
}

// Center/Enter on this panel should step through the fields one at a time —
// only actually submitting once focus has reached a Submit button itself
// (see updateSoftkeysForFocus(), which shows "Next" until then). Shared by
// both the physical-key path (wireAdvanceOnEnter, used for both the static
// fields and any dynamically-added extra-serving fields) and the on-screen
// center softkey click handler.
function newFoodCenterAction() {
  var el = focused();
  if (isNewFoodSubmitBtn(el)) {
    submitNewFood();
  } else if (el && !isTextInput(el)) {
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

// Generic across every "step through fields, only Submit actually submits"
// panel (New Food, and now Recipe Builder / Guesstimate) — each just passes
// its own center-action dispatcher.
function wireAdvanceOnEnter(el, centerActionFn) {
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Without this, the keydown would keep bubbling to the document-level
      // handler after centerActionFn() has already moved focus — if that
      // landed on the Submit button, its "non-text-input" Enter case would
      // immediately fire too, submitting on the very keystroke that was
      // only meant to move focus onto the button.
      e.stopPropagation();
      centerActionFn();
    }
  });
}

NEW_FOOD_NUMERIC_FIELDS.forEach(function (id) {
  wireNumericField(document.getElementById(id));
});

NEW_FOOD_NUMERIC_FIELDS.concat(['input-new-food-name', 'input-new-food-serving-name']).forEach(function (id) {
  wireAdvanceOnEnter(document.getElementById(id), newFoodCenterAction);
});

document.getElementById('btn-new-food-submit').addEventListener('click', submitNewFood);
document.getElementById('btn-new-food-submit-bottom').addEventListener('click', submitNewFood);

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
    wireAdvanceOnEnter(input, newFoodCenterAction);
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

// prefill is either a plain string (every pre-existing caller — just the
// search query, to prefill Name) or a {name, upc, servings} object (a UPC
// lookup result) — servings' first entry fills the primary serving fields,
// any more become extra-serving blocks via the same addExtraServingBlock()
// "+ Add additional serving" already builds, rather than a second copy of
// that field-building logic.
function showNewFoodPanel(prefill) {
  var prefillObj = (prefill && typeof prefill === 'object') ? prefill : { name: prefill || '' };
  var servings = prefillObj.servings || [];
  var primary = servings[0] || {};

  document.getElementById('input-new-food-name').value = prefillObj.name || '';
  document.getElementById('input-new-food-serving-qty').value = primary.quantity != null ? formatQty(primary.quantity) : '';
  document.getElementById('input-new-food-serving-name').value = primary.name || '';
  document.getElementById('input-new-food-calories').value = primary.calories != null ? primary.calories : '';
  document.getElementById('input-new-food-fat').value = primary.fat != null ? primary.fat : '';
  document.getElementById('input-new-food-carbs').value = primary.carbohydrates != null ? primary.carbohydrates : '';
  document.getElementById('input-new-food-protein').value = primary.protein != null ? primary.protein : '';
  document.getElementById('input-new-food-upc').value = prefillObj.upc || '';
  document.getElementById('extra-servings-container').innerHTML = '';
  extraServingCount = 0;

  servings.slice(1).forEach(function (serving) {
    var block = addExtraServingBlock();
    block.querySelector('.extra-serving-serving-qty').value = serving.quantity != null ? formatQty(serving.quantity) : '';
    block.querySelector('.extra-serving-serving-name').value = serving.name || '';
    block.querySelector('.extra-serving-calories').value = serving.calories != null ? serving.calories : '';
    block.querySelector('.extra-serving-fat').value = serving.fat != null ? serving.fat : '';
    block.querySelector('.extra-serving-carbs').value = serving.carbohydrates != null ? serving.carbohydrates : '';
    block.querySelector('.extra-serving-protein').value = serving.protein != null ? serving.protein : '';
  });

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
  var upc = document.getElementById('input-new-food-upc').value.trim() || null;

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
    // state. Submission itself is anonymous-friendly too — admin review is
    // the actual spam gate on the moderation queue, not login (see
    // backend/README.md) — logging in just attaches it to an account for
    // multi-device sync.
    dbPutMySubmission({ id: id, createdAt: nowSec(), submittedAt: null, submitStatus: 'local' }, function () {
      gateOrAddToDiary(food, null, null, function () {
        submitNewFoodToApi(id, name, food.servings, upc);
        showDiaryPanel();
        showStatus('Added ' + name, false);
      });
    });
  });
}

// Submitting is best-effort/non-blocking relative to the local add above —
// a failure here is just logged, never surfaced to the user, since the food
// is already usable locally regardless. Anonymous-friendly: /submit doesn't
// require login (admin review is the actual spam gate on the moderation
// queue), so this runs unconditionally — getCsrf() is simply empty/absent
// when logged out, and the backend treats that as an anonymous submission.
//
// Only a genuine 200 from /submit flips this food's My Foods status from
// "Local" to "Approval Pending" — a timeout, 401/403, or any other failure
// leaves it exactly as "Local", per spec.
function submitNewFoodToApi(id, name, servings, upc) {
  postSubmitJson(id, name, servings, upc)
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

function postSubmitJson(id, name, servings, upc) {
  var body = {
    id: id,
    name: name,
    servings: servings,
    csrf: getCsrf()
  };
  // Backend creates a pending UPC mapping (to this food's id + its first
  // serving) as a side effect when present — see backend/README.md's "UPC
  // mappings" note. Never stored on the food record itself.
  if (upc) body.upc = upc;
  return xhrPostJson(SUBMIT_URL, body);
}

// Best-effort/non-blocking, same philosophy as submitNewFoodToApi above —
// the diary add this accompanies (commitMatchedFoodToDiaryAndProposeMapping)
// has already succeeded locally regardless of whether this call ever lands.
// xhrPostJson already sends cookies, so a logged-in session, if any, is
// attached automatically; getCsrf() is simply absent when logged out, which
// the backend's @optionally_authenticate_user treats as anonymous.
function submitUpcMappingProposal(upc, foodId, foodName, servingName, servingQuantity) {
  xhrPostJson(SUBMIT_UPC_MAPPING_URL, {
    csrf: getCsrf(),
    upc: upc,
    foodId: foodId,
    foodName: foodName,
    servingName: servingName,
    servingQuantity: String(servingQuantity)
  }).catch(function (err) {
    console.log('UPC mapping proposal failed (non-blocking)', err);
  });
}

// ─── Screen: Guesstimate ────────────────────────────────────────────────────
//
// Deliberately minimal — just a name and a calorie guess, nothing else.
// The whole point is speed: a vague, in-the-moment estimate that's at least
// named (unlike a typical "quick add" with no way to remember what it was
// later). Logs straight into today's diary with no backing food record —
// never becomes a reusable/searchable food, never touches /submit.

function showGuesstimatePanel(prefillName) {
  document.getElementById('input-guesstimate-name').value = prefillName || '';
  document.getElementById('input-guesstimate-calories').value = '';
  // No `food` object exists for a guesstimate, so it can't reuse
  // gateOrAddToDiary/panel-servings — the meal picker lives directly on
  // this form instead, shown/required per the same two settings.
  var mealsOn = getMealsEnabled();
  applyMealFieldVisibility('wrap-guesstimate-meal', mealsOn);
  if (mealsOn) populateMealSelect(document.getElementById('input-guesstimate-meal'), null, getRequireMealSelection());
  showPanel('panel-guesstimate');
}

document.getElementById('input-guesstimate-calories').addEventListener('input', function (e) {
  sanitizeQtyInput(e.target);
});

function guesstimateCenterAction() {
  var el = focused();
  if (el && el.id === 'btn-guesstimate-submit') submitGuesstimate();
  else moveFocus('down');
}

wireAdvanceOnEnter(document.getElementById('input-guesstimate-name'), guesstimateCenterAction);
wireAdvanceOnEnter(document.getElementById('input-guesstimate-calories'), guesstimateCenterAction);
document.getElementById('btn-guesstimate-submit').addEventListener('click', submitGuesstimate);

function submitGuesstimate() {
  var name = document.getElementById('input-guesstimate-name').value.trim();
  var calories = parseFloat(document.getElementById('input-guesstimate-calories').value);

  if (!name || isNaN(calories)) {
    showStatus('Name and calories are required', true);
    return;
  }

  var mealId = null;
  if (getMealsEnabled()) {
    var mealSelect = document.getElementById('input-guesstimate-meal');
    if (getRequireMealSelection() && mealSelect.value === '__unset__') {
      showStatus('Select a meal', true);
      return;
    }
    mealId = mealSelect.value || null;
  }

  var entry = {
    date: state.currentDate,
    foodId: null,
    foodName: name,
    servingName: 'guess',
    quantity: 1,
    calories: round2(calories),
    fat: 0,
    carbohydrates: 0,
    protein: 0,
    type: 'guesstimate',
    guid: generateGuid(),
    updated: nowSec(),
    createdAt: nowSec(),
    mealId: mealId,
    deleted: false
  };

  dbAddDiaryEntry(entry, function () {
    showDiaryPanel();
    showStatus('Added ' + name, false);
    syncAfterDiaryMutation();
  });
}

// ─── Screen: Recipe Builder ─────────────────────────────────────────────────
//
// A recipe is stored as a normal `foods` record (type:'recipe') so it gets
// search/diary/sync for free — see the ingredients snapshot below for why
// that's safe even if an ingredient food is later edited/deleted. Its
// nutrition-per-serving is baked in once at Save time, never recomputed
// later from the ingredient list.

function showRecipeBuilderPanel(prefillName) {
  // editingId: null means Submit creates a new recipe (and logs it to the
  // diary); editing an existing one (see showRecipeBuilderPanelForEdit)
  // sets it instead, which submitRecipe() checks to update in place.
  state.recipeBuilder = { ingredients: [], editingId: null };
  document.getElementById('recipe-builder-title').textContent = 'New Recipe';
  document.getElementById('input-recipe-name').value = prefillName || '';
  document.getElementById('input-recipe-servings-count').value = '1';
  renderRecipeIngredientsList();
  showPanel('panel-recipe-builder');
}

// Reached from My Recipes' "Edit" action — the exact same builder panel
// creation uses, just pre-filled from the existing recipe's own snapshot
// (ingredients already store foodId/foodName/servingName/quantity, so no
// re-lookup is needed) and wired to update that recipe in place on Submit
// rather than create a new one or log a diary entry.
function showRecipeBuilderPanelForEdit(recipe) {
  state.recipeBuilder = {
    ingredients: (recipe.ingredients || []).map(function (ing) {
      return { foodId: ing.foodId, foodName: ing.foodName, servingName: ing.servingName, quantity: ing.quantity };
    }),
    editingId: recipe.id
  };
  document.getElementById('recipe-builder-title').textContent = 'Edit Recipe';
  document.getElementById('input-recipe-name').value = recipe.name;
  document.getElementById('input-recipe-servings-count').value = formatQty(recipe.servingsCount || 1);
  renderRecipeIngredientsList();
  showPanel('panel-recipe-builder');
}

// Unlike showRecipeBuilderPanel(), preserves the name/servings-count/
// ingredients already entered (create or edit mode alike — editingId lives
// in state.recipeBuilder, untouched here) — used when returning from
// picking an ingredient's quantity, mirroring returnToSearchPanel() vs
// showSearchPanel().
function resumeRecipeBuilderPanel() {
  showPanel('panel-recipe-builder');
  renderRecipeIngredientsList();
  setFocus(document.getElementById('btn-recipe-add-ingredient'));
}

// Scales an ingredient's backing serving by its own quantity — shared by
// renderRecipeIngredientsList (per-row calories, matching how a Diary row
// shows one) and computeRecipeTotals (recipe-wide sums for the live
// preview and the actual baked-serving save), so the same food/serving/
// scale lookup isn't repeated in three places. Returns null if the food or
// that exact serving isn't found locally (e.g. it vanished since picked).
function computeIngredientNutrients(ing) {
  var food = state.foodsById[ing.foodId];
  var serving = food && food.servings.filter(function (s) { return s.name === ing.servingName; })[0];
  if (!serving) return null;
  var scale = serving.quantity ? (ing.quantity / serving.quantity) : 0;
  var values = {};
  Object.keys(serving).forEach(function (key) {
    if (key === 'name' || key === 'quantity') return;
    values[key] = serving[key] * scale;
  });
  return values;
}

// Sums computeIngredientNutrients() across every ingredient — used both by
// the live per-serving preview below and by submitRecipe() at actual save
// time, so the preview always matches what gets baked/saved.
function computeRecipeTotals(ingredients) {
  var totals = {};
  var skipped = 0;
  ingredients.forEach(function (ing) {
    var values = computeIngredientNutrients(ing);
    if (!values) { skipped++; return; }
    Object.keys(values).forEach(function (key) {
      totals[key] = (totals[key] || 0) + values[key];
    });
  });
  return { totals: totals, skipped: skipped };
}

function renderRecipeIngredientsList() {
  var ul = document.getElementById('recipe-ingredients-ul');
  ul.innerHTML = '';
  var list = state.recipeBuilder.ingredients;
  document.getElementById('recipe-ingredients-empty').style.display = list.length ? 'none' : 'block';
  list.forEach(function (ing, idx) {
    var li = document.createElement('li');
    li.className = 'food-row recipe-ingredient-row';
    li.setAttribute('nav-selectable', 'true');

    var name = document.createElement('span');
    name.className = 'food-row-name';
    name.textContent = ing.foodName;

    var qty = document.createElement('span');
    qty.className = 'food-row-serving';
    qty.textContent = formatQty(ing.quantity) + ' ' + ing.servingName;

    var cal = document.createElement('span');
    cal.className = 'food-row-calories';
    var ingValues = computeIngredientNutrients(ing);
    cal.textContent = Math.round((ingValues && ingValues.calories) || 0);

    li.appendChild(name);
    li.appendChild(qty);
    li.appendChild(cal);
    li.addEventListener('click', function () { openIngredientActionsSheet(idx); });
    ul.appendChild(li);
  });
  renderRecipePreview();
}

// Live "what one serving of this will contain" preview — same summary-
// table + nutrient-table pattern as the Servings panel, kept in sync with
// this same data on every ingredient add/remove and every keystroke in the
// servings-count field (see its 'input' listener below). Deliberately
// per-serving, not recipe-wide totals, since that's what actually gets
// logged to the diary once saved — matches computeRecipeTotals()/
// submitRecipe()'s own math exactly, so the preview never lies.
function renderRecipePreview() {
  var servingsCount = parseFloat(document.getElementById('input-recipe-servings-count').value) || 0;
  var totals = computeRecipeTotals(state.recipeBuilder.ingredients).totals;
  var values = {};
  Object.keys(totals).forEach(function (key) {
    values[key] = servingsCount ? totals[key] / servingsCount : 0;
  });
  renderMacroSummary('recipe', values);
  renderNutrientTable('recipe-nutrients', values);
}

// A destructive action (removing an ingredient) always requires this
// deliberate second step — a sheet tap, not a stray Enter on the row
// itself — same "no single keystroke should delete something" principle
// as the extra-serving-block Remove button in New Food, just achieved
// differently since these rows have no per-row input fields to place a
// button after.
function openIngredientActionsSheet(idx) {
  var ing = state.recipeBuilder.ingredients[idx];
  openSheet(
    [
      {
        label: 'Remove', danger: true, action: function () {
          closeSheet();
          state.recipeBuilder.ingredients.splice(idx, 1);
          renderRecipeIngredientsList();
        }
      },
      { label: 'Cancel', action: function () { closeSheet(); } }
    ],
    { title: ing.foodName, note: formatQty(ing.quantity) + ' ' + ing.servingName }
  );
}

document.getElementById('btn-recipe-add-ingredient').addEventListener('click', showSearchPanelForRecipeIngredient);

wireAdvanceOnEnter(document.getElementById('input-recipe-name'), recipeBuilderCenterAction);
wireNumericField(document.getElementById('input-recipe-servings-count'));
wireAdvanceOnEnter(document.getElementById('input-recipe-servings-count'), recipeBuilderCenterAction);
document.getElementById('input-recipe-servings-count').addEventListener('input', renderRecipePreview);
document.getElementById('btn-recipe-submit').addEventListener('click', submitRecipe);

function recipeBuilderCenterAction() {
  var el = focused();
  if (el && el.id === 'btn-recipe-submit') submitRecipe();
  else if (el && !isTextInput(el)) interact(el); // "+ Add ingredient" button, or an ingredient row
  else moveFocus('down');
}

function submitRecipe() {
  var name = document.getElementById('input-recipe-name').value.trim();
  var servingsCount = parseFloat(document.getElementById('input-recipe-servings-count').value);
  var ingredients = state.recipeBuilder.ingredients;

  if (!name) { showStatus('Recipe name is required', true); return; }
  if (!ingredients.length) { showStatus('Add at least one ingredient', true); return; }
  if (!servingsCount || servingsCount <= 0) { showStatus('Enter how many servings this makes', true); return; }

  // Same computation the live preview above already showed — degrades
  // gracefully (skipped, not blocked) if a food/serving vanished locally
  // since it was picked.
  var recipeTotals = computeRecipeTotals(ingredients);
  var totals = recipeTotals.totals;
  var skipped = recipeTotals.skipped;

  var bakedServing = { name: 'serving', quantity: 1 };
  Object.keys(totals).forEach(function (key) { bakedServing[key] = round2(totals[key] / servingsCount); });

  var editingId = state.recipeBuilder.editingId;
  var id = editingId || generateGuid();
  var recipe = {
    id: id,
    name: name,
    type: 'recipe',
    servings: [bakedServing],
    ingredients: ingredients,
    servingsCount: servingsCount,
    source: 'local',
    updated: nowSec(),
    deleted: false
  };

  dbBulkPutFoods([recipe], function () {
    upsertStateFood(recipe);
    if (editingId) {
      // Editing only updates the recipe's own definition — it never logs a
      // diary entry (unlike creating one), so only a foods sync is needed.
      showMyRecipesPanel();
      showStatus('Saved' + (skipped ? ' (some ingredients were unavailable and skipped)' : ''), false);
      syncFoods();
    } else {
      // Mirrors submitNewFood()'s immediate-add-to-diary behavior — a recipe
      // never goes through submitNewFoodToApi/`/submit`, it only ever exists
      // locally/synced to this account, never submitted for catalog review.
      gateOrAddToDiary(recipe, null, null, function () {
        showDiaryPanel();
        showStatus('Added ' + name + (skipped ? ' (some ingredients were unavailable and skipped)' : ''), false);
        syncFoods();
        syncAfterDiaryMutation();
      });
    }
  });
}

// ─── Screen: My Recipes ──────────────────────────────────────────────────────

function showMyRecipesPanel() {
  renderMyRecipesList();
  showPanel('panel-my-recipes');
  setSoftkeys('Back', 'SELECT', '');
}

function renderMyRecipesList() {
  var ul = document.getElementById('my-recipes-ul');
  ul.innerHTML = '';
  var recipes = state.allFoods
    .filter(function (f) { return f.type === 'recipe' && f.deleted !== true; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  document.getElementById('my-recipes-empty').style.display = recipes.length ? 'none' : 'block';
  recipes.forEach(function (recipe) {
    var li = document.createElement('li');
    li.className = 'options-row my-recipe-row';
    li.setAttribute('nav-selectable', 'true');

    var name = document.createElement('span');
    name.className = 'options-label';
    name.textContent = recipe.name;

    var meta = document.createElement('span');
    meta.className = 'options-value';
    var count = (recipe.ingredients || []).length;
    meta.textContent = count + (count === 1 ? ' ingredient' : ' ingredients');

    li.appendChild(name);
    li.appendChild(meta);
    li.addEventListener('click', function () { openMyRecipeActionsSheet(recipe.id); });
    ul.appendChild(li);
  });
}

function openMyRecipeActionsSheet(recipeId) {
  var recipe = state.foodsById[recipeId];
  openSheet(
    [
      { label: 'Edit', action: function () { closeSheet(); editRecipe(recipeId); } },
      { label: 'Delete', danger: true, action: function () { closeSheet(); deleteRecipe(recipeId); } },
      { label: 'Cancel', action: function () { closeSheet(); } }
    ],
    { title: recipe ? recipe.name : 'Recipe', note: 'What would you like to do with this recipe?' }
  );
}

// Opens the same Recipe Builder panel used for creation, pre-filled from
// this recipe's own snapshot — Submit there updates it in place (see
// submitRecipe()'s editingId branch) rather than creating a new one.
function editRecipe(recipeId) {
  var recipe = state.foodsById[recipeId];
  if (!recipe) { showStatus('Recipe data unavailable', true); return; }
  showRecipeBuilderPanelForEdit(recipe);
}

function refreshOptionsMyRecipesCount() {
  var count = state.allFoods.filter(function (f) { return f.type === 'recipe' && f.deleted !== true; }).length;
  document.getElementById('opt-my-recipes-count').textContent = count ? String(count) : '';
}

document.getElementById('opt-my-recipes').addEventListener('click', function () {
  state.myFoodsBackTo = 'options';
  showMyRecipesPanel();
});

// Mirrors deleteMyFood()'s tombstone-vs-hard-delete logic exactly, minus the
// mySubmissions bookkeeping step — a recipe never has one. Only correctly
// reaches another device once logged in because buildFoodsSyncPayload()
// explicitly includes local recipes (see its comment) — without that, a
// tombstoned recipe would never be picked up by /sync/foods at all.
function deleteRecipe(recipeId) {
  function afterUiUpdate() {
    renderMyRecipesList();
    refreshOptionsMyRecipesCount();
    showStatus('Deleted', false);
    syncFoods();
  }
  if (getEverLoggedIn()) {
    dbSoftDeleteFood(recipeId, function () {
      if (state.foodsById[recipeId]) state.foodsById[recipeId].deleted = true;
      afterUiUpdate();
    });
  } else {
    delete state.foodsById[recipeId];
    state.allFoods = state.allFoods.filter(function (f) { return f.id !== recipeId; });
    var tx = db.transaction('foods', 'readwrite');
    tx.objectStore('foods').delete(recipeId);
    tx.oncomplete = afterUiUpdate;
    tx.onerror = afterUiUpdate;
  }
}

// ─── Screen: Meals ────────────────────────────────────────────────────────────
//
// Structurally the same "tap a row, act on it via a sheet" pattern as My
// Foods/My Recipes above, plus reordering — which has no precedent
// anywhere else in this app (recipes are alphabetized, not stored-order;
// recipe ingredients and extra-servings are append-only). Reuses the
// existing openSheet action-sheet primitive for Move Up/Move Down rather
// than inventing a drag/drop-style interaction this D-pad UI can't support
// anyway.

function showMealsPanel() {
  renderMealsList();
  showPanel('panel-meals');
  setSoftkeys('Back', 'SELECT', '');
}

function renderMealsList() {
  var meals = getMeals();
  var ul = document.getElementById('meals-ul');
  ul.innerHTML = '';
  document.getElementById('meals-empty').style.display = meals.length ? 'none' : 'block';
  meals.forEach(function (meal, idx) {
    var li = document.createElement('li');
    li.className = 'options-row meal-row';
    li.setAttribute('nav-selectable', 'true');
    var name = document.createElement('span');
    name.className = 'options-label';
    name.textContent = meal.name;
    li.appendChild(name);
    li.addEventListener('click', function () { openMealActionsSheet(idx); });
    ul.appendChild(li);
  });
}

function openMealActionsSheet(idx) {
  var meals = getMeals();
  var meal = meals[idx];
  if (!meal) return;
  var items = [{ label: 'Rename', action: function () { closeSheet(); promptRenameMeal(idx); } }];
  if (idx > 0) items.push({ label: 'Move Up', action: function () { closeSheet(); moveMeal(idx, idx - 1); } });
  if (idx < meals.length - 1) items.push({ label: 'Move Down', action: function () { closeSheet(); moveMeal(idx, idx + 1); } });
  items.push({ label: 'Delete', danger: true, action: function () { closeSheet(); confirmDeleteMeal(idx); } });
  items.push({ label: 'Cancel', action: function () { closeSheet(); } });
  openSheet(items, { title: meal.name, note: 'What would you like to do with this meal?' });
}

function moveMeal(fromIdx, toIdx) {
  var meals = getMeals();
  if (toIdx < 0 || toIdx >= meals.length) return;
  meals.splice(toIdx, 0, meals.splice(fromIdx, 1)[0]);
  setMeals(meals);
  renderMealsList();
}

function confirmDeleteMeal(idx) {
  var meal = getMeals()[idx];
  if (!meal) return;
  openSheet(
    [
      { label: 'Yes, delete "' + meal.name + '"', danger: true, action: function () { closeSheet(); deleteMeal(idx); } },
      { label: 'Cancel', action: function () { closeSheet(); } }
    ],
    { title: 'Delete meal?', note: 'Entries currently assigned to this meal will move to "Other" — they are not deleted.' }
  );
}

// Diary entries referencing this meal's id are left completely untouched —
// renderDiaryGrouped() already treats any mealId not present in getMeals()
// as unassigned, so this needs no entry-rewrite step at all.
function deleteMeal(idx) {
  var meals = getMeals();
  meals.splice(idx, 1);
  setMeals(meals);
  renderMealsList();
  refreshOptionsMealsCount();
  showStatus('Deleted', false);
}

var _mealEditIdx = null; // null => Add; index => Rename

function showAddMealPanel() {
  _mealEditIdx = null;
  document.getElementById('meal-edit-title').textContent = 'Add Meal';
  document.getElementById('input-meal-name').value = '';
  showPanel('panel-meal-edit');
}

function promptRenameMeal(idx) {
  var meal = getMeals()[idx];
  if (!meal) return;
  _mealEditIdx = idx;
  document.getElementById('meal-edit-title').textContent = 'Rename Meal';
  document.getElementById('input-meal-name').value = meal.name;
  showPanel('panel-meal-edit');
}

function saveMealEdit() {
  var name = document.getElementById('input-meal-name').value.trim();
  if (!name) { showStatus('Enter a name', true); return; }
  var meals = getMeals();
  if (_mealEditIdx === null) meals.push({ id: generateGuid(), name: name });
  else meals[_mealEditIdx].name = name;
  setMeals(meals);
  showMealsPanel();
  showStatus('Saved', false);
}

document.getElementById('btn-meals-add').addEventListener('click', showAddMealPanel);
document.getElementById('btn-meal-edit-save').addEventListener('click', saveMealEdit);
wireAdvanceOnEnter(document.getElementById('input-meal-name'), saveMealEdit);

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
  document.getElementById('opt-show-alcohol-value').textContent = getShowAlcohol() ? 'On' : 'Off';
  document.getElementById('opt-after-add-food-value').textContent = getAfterAddFood() === 'modify' ? 'Modify servings' : 'Return to diary';
  document.getElementById('opt-meals-enabled-value').textContent = getMealsEnabled() ? 'On' : 'Off';
  document.getElementById('opt-require-meal-selection-value').textContent = getRequireMealSelection() ? 'On' : 'Off';
  applyMealsVisibility();
  refreshOptionsMealsCount();
  refreshOptionsAccountRow();
  refreshOptionsMyRecipesCount();

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

// Bypasses the normal once-a-week throttle (see shouldCheckManifest) at the
// user's own request — reuses the same loading-screen UI the boot-time
// sync already shows, then returns to Options with a status toast instead
// of proceeding to the Diary panel the way the boot sync does.
function forceCheckManifest() {
  showPanel('panel-loading');
  document.getElementById('loading-count').textContent = 'Checking for updates…';
  document.getElementById('loading-filename').textContent = '';
  document.getElementById('loading-progress-fill').style.width = '0%';

  syncData(
    function onFileStart(index, total, fileEntry) {
      var filename = fileEntry.url.replace(/^\//, '');
      document.getElementById('loading-count').textContent = 'Loading ' + index + ' of ' + total + ' database files…';
      document.getElementById('loading-filename').textContent = filename;
      document.getElementById('loading-progress-fill').style.width = '0%';
    },
    function onFileProgress(fraction) {
      var pct = fraction === null ? 100 : Math.round(fraction * 100);
      document.getElementById('loading-progress-fill').style.width = pct + '%';
    },
    function onDone(filesDownloaded) {
      dbGetAllFoods(function (foods) {
        state.allFoods = foods;
        state.foodsById = {};
        foods.forEach(function (f) { state.foodsById[f.id] = f; });
        showOptionsPanel();
        if (getLastSyncError()) {
          showStatus('Check failed — see Last Sync Error below', true);
        } else if (filesDownloaded) {
          showStatus('Downloaded ' + filesDownloaded + ' new file' + (filesDownloaded === 1 ? '' : 's'), false);
        } else {
          showStatus('Already up to date', false);
        }
      });
    },
    true
  );
}

document.getElementById('opt-check-for-data').addEventListener('click', forceCheckManifest);

document.getElementById('opt-login').addEventListener('click', function () {
  if (isLoggedIn()) {
    openAccountSheet();
  } else {
    showLoginEmailPanel();
  }
});

document.getElementById('opt-my-foods').addEventListener('click', function () {
  state.myFoodsBackTo = 'options';
  showMyFoodsPanel();
});

document.getElementById('opt-show-caffeine').addEventListener('click', function () {
  setShowCaffeine(!getShowCaffeine());
  document.getElementById('opt-show-caffeine-value').textContent = getShowCaffeine() ? 'On' : 'Off';
});

document.getElementById('opt-show-alcohol').addEventListener('click', function () {
  setShowAlcohol(!getShowAlcohol());
  document.getElementById('opt-show-alcohol-value').textContent = getShowAlcohol() ? 'On' : 'Off';
});

document.getElementById('opt-after-add-food').addEventListener('click', function () {
  setAfterAddFood(getAfterAddFood() === 'modify' ? 'direct' : 'modify');
  document.getElementById('opt-after-add-food-value').textContent = getAfterAddFood() === 'modify' ? 'Modify servings' : 'Return to diary';
});

document.getElementById('opt-meals-enabled').addEventListener('click', function () {
  setMealsEnabled(!getMealsEnabled());
  document.getElementById('opt-meals-enabled-value').textContent = getMealsEnabled() ? 'On' : 'Off';
  applyMealsVisibility();
  refreshOptionsMealsCount();
});

document.getElementById('opt-require-meal-selection').addEventListener('click', function () {
  setRequireMealSelection(!getRequireMealSelection());
  document.getElementById('opt-require-meal-selection-value').textContent = getRequireMealSelection() ? 'On' : 'Off';
});

document.getElementById('opt-meals').addEventListener('click', showMealsPanel);

document.getElementById('opt-sync-error-row').addEventListener('click', function () {
  var err = getLastSyncError();
  if (!err) return;
  openSheet(
    [{ label: 'Dismiss', action: function () { closeSheet(); } }],
    { title: 'Last Sync Error', note: err.at + ' — ' + err.message }
  );
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
  // Another open connection (a second tab, or even just DevTools' own
  // IndexedDB inspector viewing this database) blocks the delete rather
  // than failing it — the request just sits pending until that connection
  // closes, then onsuccess still fires above. Reloading immediately here
  // used to be the bug: the reloaded page's indexedDB.open() call queues
  // up behind this still-pending delete and never resolves, since nothing
  // closed the blocking connection — the app just hangs forever. Telling
  // the user what's actually blocking it, instead of reloading into that
  // hang, is the fix.
  req.onblocked = function () {
    showStatus('Close other tabs (or DevTools’ IndexedDB panel) with this app open, then try again', true);
  };
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

// Diary bottom nav's My Foods button (>240px touchscreen UI) — a thin
// chooser between the two existing, unchanged My Foods/My Recipes panels
// below, not a merged list. See state.myFoodsBackTo for how Back from
// either of those routes back here instead of Options when reached this way.
function showFoodsRecipesPanel() {
  showPanel('panel-foods-recipes');
  setSoftkeys('Back', 'SELECT', '');
}

document.getElementById('btn-foods-recipes-foods').addEventListener('click', function () {
  state.myFoodsBackTo = 'foods-recipes';
  showMyFoodsPanel();
});
document.getElementById('btn-foods-recipes-recipes').addEventListener('click', function () {
  state.myFoodsBackTo = 'foods-recipes';
  showMyRecipesPanel();
});

document.getElementById('btn-bottom-nav-foods').addEventListener('click', showFoodsRecipesPanel);
document.getElementById('btn-bottom-nav-add').addEventListener('click', showSearchPanel);
document.getElementById('btn-bottom-nav-settings').addEventListener('click', showOptionsPanel);

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
        // Recipes should never have a mySubmissions row at all (see
        // reconcileMySubmissionsFromFoodsSync), but this guard skips one
        // defensively in case stray data exists.
        if (!food || food.deleted === true || food.type === 'recipe') {
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

          // Status used to render here ("Local"/"Approval Pending"/etc.) —
          // dropped since an approved food no longer lingers in this list
          // at all (see dbBulkDeleteMySubmissions in syncData), so the only
          // statuses left to show were the uninteresting ones. Calories are
          // more useful at a glance; computeMyFoodStatus is still used
          // below, just for openMyFoodActionsSheet's own logic now.
          var calEl = document.createElement('span');
          calEl.className = 'options-value';
          calEl.textContent = Math.round(defaultServingForFood(food).serving.calories || 0) + ' cal';

          li.appendChild(name);
          li.appendChild(calEl);
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

// Only ever resends name/servings — a food's original UPC (if any) was
// never persisted locally as part of the food record itself (see
// backend/README.md's UPC mappings note), so a re-submit can't re-attach a
// mapping either. Anonymous-friendly, same as the original submission.
function resubmitFood(foodId) {
  dbGetFood(foodId, function (food) {
    if (!food) { showStatus('Food data unavailable', true); return; }
    postSubmitJson(foodId, food.name, food.servings).then(function (res) {
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
applyAlcoholVisibility();
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
