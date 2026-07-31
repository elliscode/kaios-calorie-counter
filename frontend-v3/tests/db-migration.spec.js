const { test, expect } = require('@playwright/test');
const { mockDataHost } = require('./helpers');

// generateGuid() produces version-4 UUIDs; catalog food ids are version-5.
var LOCAL_GUID = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
var CATALOG_UUID = 'bbbbbbbb-2222-5bbb-9bbb-bbbbbbbbbbbb';

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

// Rather than racing two separate indexedDB.open() calls across the init
// script / app.js boundary, this seeds a v3-shaped database and then calls
// the app's own real openDB() a second time, sequentially, all within the
// same already-loaded page — that's the exact function (and DB_VERSION)
// production code runs for a real upgrading install, just triggered
// on-demand instead of racing page load.
async function seedV3AndMigrate(page) {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.evaluate(function () {
    return new Promise(function (resolve, reject) {
      if (window.db) { window.db.close(); window.db = null; }
      var delReq = indexedDB.deleteDatabase('kaios-calorie-counter');
      delReq.onsuccess = function () { resolve(); };
      delReq.onblocked = function () { resolve(); };
      delReq.onerror = function () { reject(delReq.error); };
    });
  });

  await page.evaluate(function (ids) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('kaios-calorie-counter', 3);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        d.createObjectStore('foods', { keyPath: 'id' });
        var diaryStore = d.createObjectStore('diary', { keyPath: 'id', autoIncrement: true });
        diaryStore.createIndex('byDate', 'date', { unique: false });
        d.createObjectStore('syncedFiles', { keyPath: 'id' });
        d.createObjectStore('usageCounts', { keyPath: 'id' });
        d.createObjectStore('lastServings', { keyPath: 'id' });
      };
      req.onsuccess = function (e) {
        var v3db = e.target.result;
        var tx = v3db.transaction(['foods', 'diary'], 'readwrite');
        tx.objectStore('foods').add({
          id: ids.local,
          name: 'My Custom Food',
          servings: [{ name: 'g', quantity: 100, calories: 50, fat: 0, carbohydrates: 0, protein: 0 }]
        });
        tx.objectStore('foods').add({
          id: ids.catalog,
          name: 'Catalog Food',
          servings: [{ name: 'g', quantity: 100, calories: 60, fat: 0, carbohydrates: 0, protein: 0 }]
        });
        tx.objectStore('diary').add({
          date: '2026-01-01', foodId: ids.local, foodName: 'My Custom Food',
          servingName: 'g', quantity: 100, calories: 50, fat: 0, carbohydrates: 0, protein: 0
        });
        tx.oncomplete = function () { v3db.close(); resolve(); };
        tx.onerror = function (ev) { reject(ev.target.error); };
      };
      req.onerror = function () { reject(req.error); };
    });
  }, { local: LOCAL_GUID, catalog: CATALOG_UUID });

  // Now trigger the real v3 -> v4 upgrade via the app's own openDB().
  await page.evaluate(function () {
    return new Promise(function (resolve) { window.openDB(function () { resolve(); }); });
  });
}

test('a pre-existing user-created food (v4 UUID) is backfilled with source:local and a mySubmissions row', async ({ page }) => {
  await seedV3AndMigrate(page);

  var food = await page.evaluate(function (id) {
    return new Promise(function (resolve) { window.dbGetFood(id, resolve); });
  }, LOCAL_GUID);
  expect(food.source).toBe('local');
  expect(food.deleted).toBe(false);
  expect(typeof food.updated).toBe('number');

  var subs = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllMySubmissions(resolve); });
  });
  var mine = subs.filter(function (s) { return s.id === LOCAL_GUID; });
  expect(mine.length).toBe(1);
  expect(mine[0].submitStatus).toBe('local');
  expect(mine[0].submittedAt).toBeNull();
});

test('a pre-existing catalog food (v5 UUID) is backfilled with source:catalog and gets no mySubmissions row', async ({ page }) => {
  await seedV3AndMigrate(page);

  var food = await page.evaluate(function (id) {
    return new Promise(function (resolve) { window.dbGetFood(id, resolve); });
  }, CATALOG_UUID);
  expect(food.source).toBe('catalog');

  var subs = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllMySubmissions(resolve); });
  });
  expect(subs.some(function (s) { return s.id === CATALOG_UUID; })).toBe(false);
});

test('a pre-existing diary entry is backfilled with a guid and sync fields', async ({ page }) => {
  await seedV3AndMigrate(page);

  var entries = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetDiaryByDate('2026-01-01', resolve); });
  });
  expect(entries.length).toBe(1);
  expect(typeof entries[0].guid).toBe('string');
  expect(entries[0].guid.length).toBeGreaterThan(0);
  expect(entries[0].deleted).toBe(false);
  expect(typeof entries[0].updated).toBe('number');
});

// Unlike foods/diary, a real v3 install already has usageCounts/lastServings
// data (from its own earlier v2->v3 backfill, or ordinary use since) — the
// v4 migration's job for these two stores is just adding the `updated`
// field /sync/preferences needs, not re-deriving anything from diary again.
// So this test seeds actual pre-existing rows directly, rather than relying
// on seedV3AndMigrate()'s single diary entry to regenerate them.
test('pre-existing usageCounts/lastServings rows get an `updated` field backfilled, without their existing data changing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.evaluate(function () {
    return new Promise(function (resolve, reject) {
      if (window.db) { window.db.close(); window.db = null; }
      var delReq = indexedDB.deleteDatabase('kaios-calorie-counter');
      delReq.onsuccess = function () { resolve(); };
      delReq.onblocked = function () { resolve(); };
      delReq.onerror = function () { reject(delReq.error); };
    });
  });

  await page.evaluate(function (id) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('kaios-calorie-counter', 3);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        d.createObjectStore('foods', { keyPath: 'id' });
        var diaryStore = d.createObjectStore('diary', { keyPath: 'id', autoIncrement: true });
        diaryStore.createIndex('byDate', 'date', { unique: false });
        d.createObjectStore('syncedFiles', { keyPath: 'id' });
        d.createObjectStore('usageCounts', { keyPath: 'id' });
        d.createObjectStore('lastServings', { keyPath: 'id' });
      };
      req.onsuccess = function (e) {
        var v3db = e.target.result;
        var tx = v3db.transaction(['foods', 'usageCounts', 'lastServings'], 'readwrite');
        tx.objectStore('foods').add({ id: id, name: 'My Custom Food', servings: [{ name: 'g', quantity: 100, calories: 50, fat: 0, carbohydrates: 0, protein: 0 }] });
        tx.objectStore('usageCounts').add({ id: id, count: 3 });
        tx.objectStore('lastServings').add({ id: id, servingName: 'g', quantity: 100 });
        tx.oncomplete = function () { v3db.close(); resolve(); };
        tx.onerror = function (ev) { reject(ev.target.error); };
      };
      req.onerror = function () { reject(req.error); };
    });
  }, LOCAL_GUID);

  await page.evaluate(function () {
    return new Promise(function (resolve) { window.openDB(function () { resolve(); }); });
  });

  var usageCounts = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllUsageCounts(resolve); });
  });
  var forLocalFood = usageCounts.filter(function (r) { return r.id === LOCAL_GUID; });
  expect(forLocalFood.length).toBe(1);
  expect(forLocalFood[0].count).toBe(3); // unchanged
  expect(typeof forLocalFood[0].updated).toBe('number');

  var lastServings = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllLastServings(resolve); });
  });
  var lastForFood = lastServings.filter(function (r) { return r.id === LOCAL_GUID; });
  expect(lastForFood.length).toBe(1);
  expect(lastForFood[0].servingName).toBe('g'); // unchanged
  expect(typeof lastForFood[0].updated).toBe('number');
});

// v5 (recipes/guesstimates) adds no new store/index and its migration block
// is pure documentation — `type` is a purely additive field nothing v4-era
// ever wrote, read safely as `undefined` everywhere. This just confirms a
// v4-shaped install upgrades to v5 cleanly: boots fine, existing records
// are completely untouched (no `type` field magically appears on them).
test('a v4-shaped install upgrades to v5 as a true no-op — app boots, existing records untouched', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.evaluate(function () {
    return new Promise(function (resolve, reject) {
      if (window.db) { window.db.close(); window.db = null; }
      var delReq = indexedDB.deleteDatabase('kaios-calorie-counter');
      delReq.onsuccess = function () { resolve(); };
      delReq.onblocked = function () { resolve(); };
      delReq.onerror = function () { reject(delReq.error); };
    });
  });

  await page.evaluate(function (id) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('kaios-calorie-counter', 4);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        d.createObjectStore('foods', { keyPath: 'id' });
        var diaryStore = d.createObjectStore('diary', { keyPath: 'id', autoIncrement: true });
        diaryStore.createIndex('byDate', 'date', { unique: false });
        d.createObjectStore('syncedFiles', { keyPath: 'id' });
        d.createObjectStore('usageCounts', { keyPath: 'id' });
        d.createObjectStore('lastServings', { keyPath: 'id' });
        d.createObjectStore('mySubmissions', { keyPath: 'id' });
      };
      req.onsuccess = function (e) {
        var v4db = e.target.result;
        var tx = v4db.transaction(['foods', 'diary'], 'readwrite');
        tx.objectStore('foods').add({
          id: id, name: 'A v4 Food', source: 'local', updated: 1700000000, deleted: false,
          servings: [{ name: 'g', quantity: 100, calories: 50, fat: 0, carbohydrates: 0, protein: 0 }]
        });
        tx.objectStore('diary').add({
          date: '2026-02-01', foodId: id, foodName: 'A v4 Food', guid: 'fixed-test-guid',
          servingName: 'g', quantity: 100, calories: 50, fat: 0, carbohydrates: 0, protein: 0,
          updated: 1700000000, deleted: false
        });
        tx.oncomplete = function () { v4db.close(); resolve(); };
        tx.onerror = function (ev) { reject(ev.target.error); };
      };
      req.onerror = function () { reject(req.error); };
    });
  }, LOCAL_GUID);

  await page.evaluate(function () {
    return new Promise(function (resolve) { window.openDB(function () { resolve(); }); });
  });

  var food = await page.evaluate(function (id) {
    return new Promise(function (resolve) { window.dbGetFood(id, resolve); });
  }, LOCAL_GUID);
  expect(food.name).toBe('A v4 Food');
  expect(food.source).toBe('local');
  expect(food.updated).toBe(1700000000); // untouched, not bumped to "now"
  expect(food.type).toBeUndefined();

  var entries = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetDiaryByDate('2026-02-01', resolve); });
  });
  expect(entries.length).toBe(1);
  expect(entries[0].guid).toBe('fixed-test-guid');
  expect(entries[0].updated).toBe(1700000000);
  expect(entries[0].type).toBeUndefined();

  // App still boots and functions normally afterward.
  await page.reload();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});
