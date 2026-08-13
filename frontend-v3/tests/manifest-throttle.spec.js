const { test, expect } = require('@playwright/test');
const path = require('path');
const { pressSoftKey } = require('./helpers');

async function mockManifestWithCounter(page) {
  var calls = { manifest: 0 };
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    calls.manifest++;
    route.fulfill({ path: path.join(__dirname, 'fixtures/manifest.json') });
  });
  await page.route('https://calories.elliscode.com/sample-foods.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/sample-foods.json') });
  });
  return calls;
}

test('a fresh install (never synced) always checks manifest.json', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);
});

test('re-launching shortly after a sync does not re-check manifest.json', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);

  // Same context -> IndexedDB + localStorage (including the just-recorded
  // lastManifestCheckAt) persist across this second launch.
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1); // still 1 -- not called again
});

test('a stale lastManifestCheckAt (before the most recent midnight) triggers a re-check', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);

  // Force it to look like the last check was ages ago (epoch 0) -- always
  // before any real midnight boundary, regardless of when this test runs.
  await page.evaluate(function () {
    localStorage.setItem('lastManifestCheckAt', '0');
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(2);
});

test('an empty local DB (e.g. after Clear Local DB) always checks manifest.json, regardless of timing', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);

  // Recent check timestamp -- would normally suppress a re-check -- but
  // wipe the DB the way Clear Local DB does (closing the app's own open
  // connection first -- deleteDatabase() otherwise blocks/hangs forever
  // behind it, same reason doClearLocalDb() does this in app.js).
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      if (db) { db.close(); }
      indexedDB.deleteDatabase('kaios-calorie-counter').onsuccess = resolve;
    });
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(2);
});

test('"Check for new data" bypasses the throttle and reports "Already up to date" when nothing changed', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-check-for-data').click();

  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Already up to date');
  expect(calls.manifest).toBe(2); // re-checked despite no throttle boundary having passed
});

test('"Check for new data" reports how many files were actually downloaded', async ({ page }) => {
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/manifest.json') });
  });
  await page.route('https://calories.elliscode.com/sample-foods.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/sample-foods.json') });
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Expand the manifest with a second, not-yet-synced file for the forced check to find.
  await page.unroute('https://calories.elliscode.com/manifest.json');
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        files: [
          { id: 'test-foods', url: '/sample-foods.json' },
          { id: 'extra-foods', url: '/extra-foods.json' }
        ]
      })
    });
  });
  await page.route('https://calories.elliscode.com/extra-foods.json', function (route) {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
  });

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-check-for-data').click();

  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Downloaded 1 new file');
});

test('mostRecentMidnight() computes the correct boundary regardless of time of day', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  var result = await page.evaluate(function () {
    function check(y, m, d, h, min) {
      var now = new Date(y, m, d, h, min, 0, 0);
      return mostRecentMidnight(now);
    }
    var midnightJuly28 = new Date(2026, 6, 28, 0, 0, 0, 0).getTime();
    return {
      // Just after midnight -> today's midnight
      justAfterMidnight: check(2026, 6, 28, 0, 1) === midnightJuly28,
      // Noon -> today's midnight
      noon: check(2026, 6, 28, 12, 0) === midnightJuly28,
      // Just before the next midnight -> still today's midnight
      justBeforeNextMidnight: check(2026, 6, 28, 23, 59) === midnightJuly28,
      // Exactly midnight -> today's midnight, not yesterday's
      exactlyMidnight: check(2026, 6, 28, 0, 0) === midnightJuly28
    };
  });

  expect(result).toEqual({
    justAfterMidnight: true,
    noon: true,
    justBeforeNextMidnight: true,
    exactlyMidnight: true
  });
});
