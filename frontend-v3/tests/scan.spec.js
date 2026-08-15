const { test, expect } = require('@playwright/test');
const path = require('path');
const { mockDataHost, mockZxing, scanBarcode, pressSoftKey, goToSearchFromDiary } = require('./helpers');

// #btn-scan-upc (and the whole Scan Result panel) is only reachable at
// widths >240px — see css/header.css's .header-action-btn gating.
test.use({ viewport: { width: 241, height: 700 } });

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await mockZxing(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
});

test('a scanned UPC_E code is expanded to UPC-A before any lookup', async ({ page }) => {
  var requestedUpcs = [];
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    requestedUpcs.push(route.request().postDataJSON().upc);
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  // "04252614" is the standard UPC-E compression of UPC-A "042100005264"
  // (a commonly-cited canonical GS1 zero-suppression example) — verified
  // independently against the expansion algorithm before writing this test.
  await scanBarcode(page, '04252614', 'UPC_E');

  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-scan-upc')).toHaveValue('042100005264');
  expect(requestedUpcs).toEqual(['042100005264']);
});

test('a scanned EAN_13 starting with 0 is tried as both the 13-digit and 12-digit form, and a hit on either is added automatically', async ({ page }) => {
  var requestedUpcs = [];
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    var upc = route.request().postDataJSON().upc;
    requestedUpcs.push(upc);
    // Only the 12-digit form (leading zero dropped) actually hits.
    if (upc === '049000028911') {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ name: 'Diet Cola', upc: upc, servings: [{ name: 'can', quantity: 1, calories: 0, fat: 0, carbohydrates: 0, protein: 0 }] })
      });
    } else {
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
    }
  });

  await scanBarcode(page, '0049000028911', 'EAN_13');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Added Diet Cola');
  expect(requestedUpcs).toEqual(['0049000028911', '049000028911']);
});

test('a scanned UPC with a lookup hit is added to the diary automatically, without creating a foods record or submitting to moderation', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Diet Cola',
        upc: '049000028911',
        servings: [{ name: 'can', quantity: 1, calories: 0, fat: 0, carbohydrates: 0, protein: 0 }]
      })
    });
  });

  var submitCalled = false;
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    submitCalled = true;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
  });

  var foodsBefore = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
  });

  await scanBarcode(page, '049000028911');

  // No confirmation panel — scanning a barcode with a lookup hit acts as
  // if the match had been confirmed already, straight into the diary.
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Added Diet Cola');
  await expect(page.locator('.food-row-name')).toHaveText('Diet Cola');

  // /lookup-upc reads from an already-vetted USDA-derived table, entirely
  // outside the admin moderation queue — this must never re-propose that
  // data back into it, and must never create a local foods record for it
  // either (the diary entry carries its own denormalized macros + upc,
  // same as a guesstimate has no backing food).
  expect(submitCalled).toBe(false);
  var foodsAfter = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
  });
  expect(foodsAfter.length).toBe(foodsBefore.length);
});

test('a new UPC with no lookup hit shows "Barcode not found"', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await scanBarcode(page, '049000028912');

  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');
  await expect(page.locator('#scan-lookup-result')).toHaveText('Barcode not found');
});

test('matching to an existing food adds it to the diary and proposes a UPC mapping', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  var mappingBody = null;
  await page.route('https://api.calories.elliscode.com/submit-upc-mapping', function (route) {
    mappingBody = route.request().postDataJSON();
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ upc: mappingBody.upc }) });
  });

  await scanBarcode(page, '049000028913');
  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');

  await page.fill('#input-scan-match-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#scan-match-ul .search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sheet-title')).toHaveText('Apple, Raw');
  var servingRow = page.locator('#sheet-ul .list-row', { hasText: '95 cal' });
  await expect(servingRow).toBeVisible();
  await servingRow.click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Added Apple, Raw');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

  await expect.poll(function () { return mappingBody; }).toEqual({
    csrf: null,
    upc: '049000028913',
    foodId: '0de56cfb-14a5-5bc1-ad1b-c93cceb61a2b',
    foodName: 'Apple, Raw',
    servingName: '1 medium',
    servingQuantity: '1'
  });
});

test('scan match search ignores punctuation — "apple raw" (no comma) still matches "Apple, Raw"', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await scanBarcode(page, '049000028914');
  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');

  await page.fill('#input-scan-match-search', 'apple raw');
  await page.waitForTimeout(250);
  await expect(page.locator('#scan-match-ul .search-row', { hasText: 'Apple, Raw' })).toBeVisible();
});

test('scan match search: token matching finds "Hershey\'s Special Dark" for "hershey special dark", and word order does not matter', async ({ page }) => {
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbBulkPutFoods([{
        id: 'test-hersheys-id',
        name: "Hershey's Special Dark",
        source: 'catalog',
        updated: Math.floor(Date.now() / 1000),
        deleted: false,
        servings: [{ name: 'bar', quantity: 1, calories: 180, fat: 12, carbohydrates: 20, protein: 2 }]
      }], resolve);
    });
  });
  await page.goto('/'); // reload so state.allFoods (populated once at boot) picks up the new food
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);

  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await scanBarcode(page, '049000028916');
  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');

  await page.fill('#input-scan-match-search', 'hershey special dark');
  await page.waitForTimeout(250);
  await expect(page.locator('#scan-match-ul .search-row', { hasText: "Hershey's Special Dark" })).toBeVisible();

  await page.fill('#input-scan-match-search', 'dark hershey'); // reordered
  await page.waitForTimeout(250);
  await expect(page.locator('#scan-match-ul .search-row', { hasText: "Hershey's Special Dark" })).toBeVisible();
});

test('"+ Create new food" prefills a blank name and just the UPC (the panel is only ever reached on a miss)', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await scanBarcode(page, '049000028915');
  await expect(page.locator('#scan-lookup-result')).toHaveText('Barcode not found');

  await page.locator('#btn-scan-create-new-food').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-new-food-name')).toHaveValue('');
  await expect(page.locator('#input-new-food-upc')).toHaveValue('049000028915');
});

test('a UPC with an already-known local mapping skips the panel entirely (preserved fast path)', async ({ page }) => {
  await page.unroute('https://calories.elliscode.com/manifest.json');
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        files: [
          { id: 'test-foods', url: '/sample-foods.json' },
          { id: 'test-upc-mappings', type: 'upc-mappings', url: '/sample-upc-mappings.json' }
        ]
      })
    });
  });
  await page.route('https://calories.elliscode.com/sample-upc-mappings.json', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { upc: '012345678905', foodId: '0de56cfb-14a5-5bc1-ad1b-c93cceb61a2b', servingName: '1 medium', servingQuantity: 1 }
      ])
    });
  });
  var lookupCalled = false;
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    lookupCalled = true;
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });
  var mappingCalled = false;
  await page.route('https://api.calories.elliscode.com/submit-upc-mapping', function (route) {
    mappingCalled = true;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
  });

  // beforeEach's own page.goto('/') already booted and synced once against
  // the plain single-file manifest, so a second goto alone would be
  // throttled and never even re-check manifest.json (see
  // manifest-throttle.spec.js's "re-launching shortly after a sync" case) —
  // wipe the local DB first, same technique that spec's own "empty local DB
  // ... always checks" case uses, to force a real re-check that picks up
  // the expanded manifest installed above.
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      if (db) { db.close(); }
      indexedDB.deleteDatabase('kaios-calorie-counter').onsuccess = resolve;
    });
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);

  await scanBarcode(page, '012345678905');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'false');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
  expect(lookupCalled).toBe(false);
  expect(mappingCalled).toBe(false);
});

test('left softkey returns to Search', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await scanBarcode(page, '049000028916');
  await expect(page.locator('#panel-scan-result')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
});

test('with "After I add a food" set to Modify servings, a lookup hit stops at the confirmation instead of auto-adding', async ({ page }) => {
  // beforeEach already navigated Diary -> Search; back out to Diary to
  // reach Options, then return the same way once the setting is flipped.
  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-after-add-food').click();
  await expect(page.locator('#opt-after-add-food-value')).toHaveText('Modify servings');
  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);

  await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Diet Cola',
        upc: '049000028930',
        servings: [{ name: 'can', quantity: 1, calories: 0, fat: 0, carbohydrates: 0, protein: 0 }]
      })
    });
  });

  await scanBarcode(page, '049000028930');

  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-panel-title')).toHaveText('Add to Diary');
  await expect(page.locator('#servings-food-name')).toHaveText('Diet Cola');

  // #softkey is hidden at this width — #topbar-accept is its replacement.
  await page.locator('#topbar-accept').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Diet Cola');
});
