'use strict';

var DATA_HOST = 'https://calories.elliscode.com';
var SUBMIT_URL = 'https://api.calories.elliscode.com/submit';
var APP_VERSION = '1.0.0';

var SUMMARY_KEYS = ['calories', 'fat', 'carbohydrates', 'protein', 'caffeine'];
var NON_NUTRIENT_KEYS = ['id', 'date', 'foodId', 'foodName', 'servingName', 'quantity', 'name'];

var state = {
  currentDate: todayStr(),
  allFoods: [],
  foodsById: {},
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
var DB_VERSION = 1;

function openDB(callback) {
  var req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = function (e) {
    var d = e.target.result;
    d.createObjectStore('foods', { keyPath: 'id' });
    var diaryStore = d.createObjectStore('diary', { keyPath: 'id', autoIncrement: true });
    diaryStore.createIndex('byDate', 'date', { unique: false });
    d.createObjectStore('syncedFiles', { keyPath: 'id' });
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

// ─── Data sync (manifest.json + food files → IndexedDB) ──────────────────────

function syncData(callback) {
  fetch(DATA_HOST + '/manifest.json')
    .then(function (res) { return res.json(); })
    .then(function (manifest) {
      dbGetSyncedFileIds(function (syncedIds) {
        var toFetch = (manifest.files || []).filter(function (f) {
          return syncedIds.indexOf(f.id) === -1;
        });
        fetchNext(0);
        function fetchNext(i) {
          if (i >= toFetch.length) { callback(); return; }
          var fileEntry = toFetch[i];
          fetch(DATA_HOST + fileEntry.url)
            .then(function (res) { return res.json(); })
            .then(function (foodsArr) {
              dbBulkPutFoods(foodsArr, function () {
                dbMarkFileSynced(fileEntry.id, function () { fetchNext(i + 1); });
              });
            })
            .catch(function () { fetchNext(i + 1); });
        }
      });
    })
    .catch(function () { callback(); }); // offline-first: fall back to whatever's already cached
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
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-diary') {
    setSoftkeys('Search', 'Edit', 'Options');
  } else if (panel.id === 'panel-search') {
    var label = state.tray.length ? ('Add (' + (state.tray.length + 1) + ')') : 'Add';
    setSoftkeys('Back', label, 'Tray');
  } else if (panel.id === 'panel-servings') {
    setSoftkeys('Back', 'Save', 'Delete');
  } else if (panel.id === 'panel-new-food') {
    setSoftkeys('Back', 'Submit', '');
  } else if (panel.id === 'panel-options') {
    setSoftkeys('Back', 'SELECT', '');
  }
}

// ─── D-pad Navigation ─────────────────────────────────────────────────────────

function activePanel() {
  return document.querySelector('.panel[active="true"]');
}

function selectables() {
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
  if (panel.id === 'panel-diary') {
    showSearchPanel();
  } else if (panel.id === 'panel-search') {
    state.tray = [];
    showDiaryPanel();
  } else if (panel.id === 'panel-servings') {
    showDiaryPanel();
  } else if (panel.id === 'panel-new-food') {
    returnToSearchPanel();
  } else if (panel.id === 'panel-options') {
    showDiaryPanel();
  }
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

document.getElementById('sk-left').addEventListener('click', handleSoftLeft);
document.getElementById('sk-right').addEventListener('click', handleSoftRight);
document.getElementById('sk-center').addEventListener('click', function () {
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-search') {
    var food = getFocusedFood();
    if (food) commitFoodAndTray(food);
    else showStatus('Select a food first', true);
  } else if (panel.id === 'panel-servings') {
    saveServingsEdit();
  } else if (panel.id === 'panel-new-food') {
    submitNewFood();
  } else {
    interact(focused());
  }
});

// ─── Screen: Diary ────────────────────────────────────────────────────────────

function showDiaryPanel() {
  showPanel('panel-diary');
  document.getElementById('input-diary-date').value = state.currentDate;
  setSoftkeys('Search', 'Edit', 'Options');
  renderDiary();
}

document.getElementById('input-diary-date').addEventListener('change', function (e) {
  state.currentDate = e.target.value || todayStr();
  renderDiary();
});

function renderDiary() {
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

function addFoodToDiaryDefault(food, callback) {
  var defaultServing = food.servings.filter(function (s) { return s.name === 'g'; })[0] || food.servings[0];
  var entry = buildDiaryEntry(food, defaultServing, defaultServing.quantity);
  dbAddDiaryEntry(entry, callback || function () {});
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

function saveServingsEdit() {
  var qty = parseFloat(document.getElementById('input-serving-qty').value) || 0;
  var baseline = currentServingBaseline();
  if (!baseline) {
    showStatus('Could not save (food data unavailable)', true);
    return;
  }
  var updated = buildDiaryEntry(state.editingFood, baseline, qty);
  dbUpdateDiaryEntry(state.editingEntry.id, updated, function () {
    showDiaryPanel();
  });
}

function deleteCurrentEntry() {
  if (!state.editingEntry) return;
  dbDeleteDiaryEntry(state.editingEntry.id, function () {
    showDiaryPanel();
    showStatus('Deleted', false);
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

NEW_FOOD_NUMERIC_FIELDS.forEach(function (id) {
  document.getElementById(id).addEventListener('input', function (e) {
    sanitizeQtyInput(e.target);
  });
});

var NEW_FOOD_SUBMIT_ON_ENTER_FIELDS = NEW_FOOD_NUMERIC_FIELDS.concat([
  'input-new-food-name',
  'input-new-food-serving-name'
]);

NEW_FOOD_SUBMIT_ON_ENTER_FIELDS.forEach(function (id) {
  document.getElementById(id).addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNewFood();
    }
  });
});

document.getElementById('btn-new-food-submit').addEventListener('click', submitNewFood);

function showNewFoodPanel(prefillName) {
  document.getElementById('input-new-food-name').value = prefillName || '';
  document.getElementById('input-new-food-serving-qty').value = '';
  document.getElementById('input-new-food-serving-name').value = '';
  document.getElementById('input-new-food-calories').value = '';
  document.getElementById('input-new-food-fat').value = '';
  document.getElementById('input-new-food-carbs').value = '';
  document.getElementById('input-new-food-protein').value = '';
  document.getElementById('input-new-food-photo').value = '';

  showPanel('panel-new-food');
  setSoftkeys('Back', 'Submit', '');
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
    }]
  };

  dbBulkPutFoods([food], function () {
    state.allFoods.push(food);
    state.foodsById[food.id] = food;

    addFoodToDiaryDefault(food, function () {
      submitNewFoodToApi(id, name, servingQty, servingName, calories, fat, carbs, protein, photo);
      showDiaryPanel();
      showStatus('Added ' + name, false);
    });
  });
}

function submitNewFoodToApi(id, name, servingQty, servingName, calories, fat, carbs, protein, photo) {
  var formData = new FormData();
  formData.append('id', id);
  formData.append('name', name);
  formData.append('servingQuantity', servingQty);
  formData.append('servingName', servingName);
  formData.append('calories', calories);
  formData.append('fat', fat);
  formData.append('carbohydrates', carbs);
  formData.append('protein', protein);
  if (photo) formData.append('photo', photo);

  // Best-effort — the API doesn't exist yet, and even once it does, this
  // must never block the local add above.
  fetch(SUBMIT_URL, { method: 'POST', body: formData })
    .catch(function (err) { console.log('New food submission failed (non-blocking)', err); });
}

// ─── Screen: Options ──────────────────────────────────────────────────────────

function showOptionsPanel() {
  document.getElementById('opt-version').textContent = APP_VERSION;
  showPanel('panel-options');
  setSoftkeys('Back', 'SELECT', '');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

openDB(function () {
  syncData(function () {
    dbGetAllFoods(function (foods) {
      state.allFoods = foods;
      state.foodsById = {};
      foods.forEach(function (f) { state.foodsById[f.id] = f; });
      showDiaryPanel();
    });
  });
});
