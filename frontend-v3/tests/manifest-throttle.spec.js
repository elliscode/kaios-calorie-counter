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

test('a stale lastManifestCheckAt (before the most recent Tuesday 8am) triggers a re-check', async ({ page }) => {
  var calls = await mockManifestWithCounter(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  expect(calls.manifest).toBe(1);

  // Force it to look like the last check was ages ago (epoch 0) -- always
  // before any real Tuesday-8am boundary, regardless of when this test runs.
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

test('mostRecentTuesday8am() computes the correct boundary for every day of the week', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  var result = await page.evaluate(function () {
    function check(y, m, d, h) {
      var now = new Date(y, m, d, h, 0, 0, 0);
      return mostRecentTuesday8am(now);
    }
    // July 2026: Mon 27, Tue 28, Wed 29 ... (picking a known real week)
    return {
      // Wednesday 29th at noon -> this week's Tuesday (28th) 8am
      wednesday: check(2026, 6, 29, 12) === new Date(2026, 6, 28, 8, 0, 0, 0).getTime(),
      // Tuesday 28th at 9am (after 8am) -> today, the 28th, 8am
      tuesdayAfter8: check(2026, 6, 28, 9) === new Date(2026, 6, 28, 8, 0, 0, 0).getTime(),
      // Tuesday 28th at 6am (before 8am) -> last week's Tuesday (21st) 8am
      tuesdayBefore8: check(2026, 6, 28, 6) === new Date(2026, 6, 21, 8, 0, 0, 0).getTime(),
      // Monday 27th (any time) -> last week's Tuesday (21st) 8am, not this week's
      monday: check(2026, 6, 27, 23) === new Date(2026, 6, 21, 8, 0, 0, 0).getTime(),
      // Sunday 26th -> last week's Tuesday (21st) 8am
      sunday: check(2026, 6, 26, 12) === new Date(2026, 6, 21, 8, 0, 0, 0).getTime()
    };
  });

  expect(result).toEqual({
    wednesday: true,
    tuesdayAfter8: true,
    tuesdayBefore8: true,
    monday: true,
    sunday: true
  });
});
