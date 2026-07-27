'use strict';

var DATA_HOST = 'https://calories.elliscode.com';
var API_HOST = 'https://api.calories.elliscode.com';
var SUBMIT_URL = API_HOST + '/submit';
var PRESIGNED_POST_URL = API_HOST + '/presigned-post';
var APP_VERSION = '3.0.5';

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
// on (matches the app's behavior before this setting existed).
function getShowCaffeine() {
  try {
    var raw = localStorage.getItem('showCaffeine');
    return raw === null ? true : raw === 'true';
  } catch (e) { return true; }
}

function setShowCaffeine(show) {
  try { localStorage.setItem('showCaffeine', String(show)); } catch (e) { /* ignore */ }
  applyCaffeineVisibility();
}

function applyCaffeineVisibility() {
  var display = getShowCaffeine() ? '' : 'none';
  var rowSum = document.getElementById('row-sum-caffeine');
  var rowServ = document.getElementById('row-serv-caffeine');
  if (rowSum) rowSum.style.display = display;
  if (rowServ) rowServ.style.display = display;
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
var DB_VERSION = 3;

function openDB(callback) {
  var req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = function (e) {
    var d = e.target.result;
    var tx = e.target.transaction;

    if (!d.objectStoreNames.contains('foods')) {
      d.createObjectStore('foods', { keyPath: 'id' });
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

    if (!d.objectStoreNames.contains('usageCounts')) {
      var usageStore = d.createObjectStore('usageCounts', { keyPath: 'id' });
      // Backfill from any diary entries that already existed before this
      // store did, so upgrading devices don't start every food at zero.
      diaryStore.getAll().onsuccess = function (ev) {
        var counts = {};
        (ev.target.result || []).forEach(function (entry) {
          counts[entry.foodId] = (counts[entry.foodId] || 0) + 1;
        });
        Object.keys(counts).forEach(function (foodId) {
          usageStore.put({ id: foodId, count: counts[foodId] });
        });
      };
    }

    if (!d.objectStoreNames.contains('lastServings')) {
      var lastServingStore = d.createObjectStore('lastServings', { keyPath: 'id' });
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
          lastServingStore.put({ id: foodId, servingName: entry.servingName, quantity: entry.quantity });
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
  tx.objectStore('lastServings').put({ id: foodId, servingName: servingName, quantity: quantity });
  tx.oncomplete = function () { callback(); };
  tx.onerror = function () { callback(); };
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
              dbBulkPutFoods(foodsArr, function () {
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
});

wireFocusForwardingWrapper('wrap-diary-date', 'input-diary-date');

function renderDiary(callback) {
  dbGetDiaryByDate(state.currentDate, function (entries) {
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
    return f.name.toLowerCase().indexOf(q) !== -1;
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
    quantity: qty
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
  document.getElementById('servings-title').textContent = entry.foodName;
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
  dbUpdateDiaryEntry(state.editingEntry.id, updated, function () {
    rememberServing(state.editingFood.id, baseline.name, qty, function () {
      showDiaryPanel();
    });
  });
}

function deleteCurrentEntry() {
  if (!state.editingEntry) return;
  var foodId = state.editingEntry.foodId;
  dbDeleteDiaryEntry(state.editingEntry.id, function () {
    state.usageCounts[foodId] = Math.max(0, (state.usageCounts[foodId] || 0) - 1);
    dbDecrementUsageCount(foodId, function () {
      showDiaryPanel();
      showStatus('Deleted', false);
    });
  });
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
    }].concat(extraServings)
  };

  dbBulkPutFoods([food], function () {
    state.allFoods.push(food);
    state.foodsById[food.id] = food;

    addFoodToDiaryDefault(food, function () {
      submitNewFoodToApi(id, name, food.servings, photo);
      showDiaryPanel();
      showStatus('Added ' + name, false);
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
function submitNewFoodToApi(id, name, servings, photo) {
  var extension = photo ? getPhotoExtension(photo) : null;
  var uploadStep = (photo && extension) ? uploadPhotoViaPresignedPost(id, extension, photo) : Promise.resolve(null);

  uploadStep
    .then(function (photoKey) {
      return postSubmitJson(id, name, servings, photoKey);
    })
    .catch(function (err) {
      console.log('New food submission failed (non-blocking)', err);
    });
}

function uploadPhotoViaPresignedPost(id, extension, photo) {
  return fetch(PRESIGNED_POST_URL, { method: 'POST', body: JSON.stringify({ id: id, extension: extension }) })
    .then(function (res) {
      if (!res.ok) throw new Error('Could not get a presigned upload URL');
      return res.json();
    })
    .then(function (presigned) {
      var formData = new FormData();
      Object.keys(presigned.fields).forEach(function (key) {
        formData.append(key, presigned.fields[key]);
      });
      formData.append('file', photo); // must be appended last — S3's required presigned-POST form shape
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
    servings: servings
  };
  if (photoKey) body.photoKey = photoKey;
  // No explicit Content-Type header — letting fetch default to text/plain
  // for a plain string body keeps this a CORS-simple request (no preflight),
  // same trick used by every other API call in this app.
  return fetch(SUBMIT_URL, { method: 'POST', body: JSON.stringify(body) });
}

// ─── Screen: Options ──────────────────────────────────────────────────────────

function showOptionsPanel() {
  document.getElementById('opt-version').textContent = APP_VERSION;
  document.getElementById('opt-show-caffeine-value').textContent = getShowCaffeine() ? 'On' : 'Off';

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

// ─── Init ─────────────────────────────────────────────────────────────────────

applyCaffeineVisibility();

openDB(function () {
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
          });
        });
      });
    }
  );
});
