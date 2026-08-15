const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
});

test('after typing settles for 500ms, exactly one /search call fires, for the final query text', async ({ page }) => {
  var calls = [];
  await page.route('https://api.calories.elliscode.com/search', function (route) {
    calls.push(route.request().postDataJSON().query);
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
  });

  // Each fill fires its own 'input' event — like several keystrokes in
  // quick succession, each one resetting the 500ms debounce timer.
  await page.fill('#input-search', 'a');
  await page.fill('#input-search', 'ap');
  await page.fill('#input-search', 'app');
  await page.fill('#input-search', 'appl');
  await page.fill('#input-search', 'apple');

  await page.waitForTimeout(700);
  expect(calls).toEqual(['apple']);
});

test('a call already in flight blocks a new one until it resolves, even if another 500ms pause elapses', async ({ page }) => {
  var calls = [];
  var resolveFirst;
  var firstResponse = new Promise(function (resolve) { resolveFirst = resolve; });

  await page.route('https://api.calories.elliscode.com/search', async function (route) {
    var query = route.request().postDataJSON().query;
    calls.push(query);
    if (query === 'apple') await firstResponse; // hold this one open until manually released
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(600); // debounce fires, call #1 starts and hangs
  expect(calls).toEqual(['apple']);

  // Type more while call #1 is still in flight, then wait past another
  // 500ms pause — the debounce fires again, but searchInProgress should
  // drop that trigger rather than starting a second overlapping call.
  await page.fill('#input-search', 'applesauce');
  await page.waitForTimeout(600);
  expect(calls).toEqual(['apple']);

  // Release call #1. A genuinely new keystroke afterward is free to fire.
  resolveFirst();
  await page.waitForTimeout(100);
  await page.fill('#input-search', 'applesauce2');
  await page.waitForTimeout(600);
  expect(calls).toEqual(['apple', 'applesauce2']);
});

test('remote results render below local matches, above "+ Add new food", tagged Catalog', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/search', function (route) {
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { name: 'Zesty Zucchini Chips', upc: '000111222333' },
        { name: 'Zippy Zucchini Fries', upc: '000111222334' }
      ])
    });
  });

  await page.fill('#input-search', 'apple'); // matches local "Apple, Raw" fixture food
  await page.waitForTimeout(700);

  var remoteRow = page.locator('.search-row', { hasText: 'Zesty Zucchini Chips' });
  await expect(remoteRow).toBeVisible();
  await expect(remoteRow.locator('.recipe-tag')).toHaveText('Catalog');

  var texts = await page.locator('#search-ul > li').allTextContents();
  var localIdx = texts.findIndex(function (t) { return t.indexOf('Apple, Raw') !== -1; });
  var remoteIdx = texts.findIndex(function (t) { return t.indexOf('Zesty Zucchini Chips') !== -1; });
  var ctaIdx = texts.findIndex(function (t) { return t.indexOf('+ Add new food') !== -1; });

  expect(localIdx).toBeGreaterThanOrEqual(0);
  expect(remoteIdx).toBeGreaterThan(localIdx);
  expect(ctaIdx).toBeGreaterThan(remoteIdx);
});

// #panel-scan-result (which handleScannedUpc funnels a hit through) is only
// reachable/laid out correctly at widths >240px — same viewport restriction
// tests/scan.spec.js itself uses for the same reason.
test.describe('selecting a remote result', () => {
  test.use({ viewport: { width: 241, height: 700 } });

  test('a remote result with a /lookup-upc hit adds it to the diary, without creating a foods record or submitting to moderation', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/search', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'Diet Cola', upc: '049000028911' }])
      });
    });
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

    await page.fill('#input-search', 'zzz-nonexistent-local-query');
    await page.waitForTimeout(700);

    await page.locator('.search-row', { hasText: 'Diet Cola' }).click();

    await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
    await expect(page.locator('.status-toast')).toHaveText('Added Diet Cola');
    await expect(page.locator('.food-row-name')).toHaveText('Diet Cola');

    // A catalog pick (/search + /lookup-upc both read from the already-
    // vetted USDA-derived table) must never re-propose that data into the
    // moderation queue, and must never create a local foods record for it
    // either — the diary entry itself carries the denormalized macros/upc.
    expect(submitCalled).toBe(false);
    var foodsAfter = await page.evaluate(function () {
      return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
    });
    expect(foodsAfter.length).toBe(foodsBefore.length);
  });
});

// Remote catalog search now runs in recipe-ingredient mode too (previously
// skipped entirely — see triggerRemoteSearch) — same backend call, same
// renderRemoteSearchResults, so these results are identical to Diary
// search's. Selecting one differs only in destination: Ingredient Quantity
// instead of the diary.
test.describe('recipe-ingredient mode', () => {
  async function goToIngredientSearch(page, recipeName) {
    await page.fill('#input-search', recipeName);
    await page.waitForTimeout(250);
    await page.locator('#panel-search .search-row.add-new-recipe').click();
    await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
    await page.locator('#btn-recipe-add-ingredient').click();
    await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  }

  test('remote results appear while picking an ingredient, same as Diary search', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/search', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'Zesty Zucchini Chips', upc: '000111222333' }])
      });
    });

    await goToIngredientSearch(page, 'my recipe');
    await page.fill('#input-search', 'zucchini');
    await page.waitForTimeout(700);

    var remoteRow = page.locator('.search-row', { hasText: 'Zesty Zucchini Chips' });
    await expect(remoteRow).toBeVisible();
    await expect(remoteRow.locator('.recipe-tag')).toHaveText('Catalog');
  });

  test('selecting a remote result with a /lookup-upc hit opens Ingredient Quantity for it, without creating a foods record or submitting to moderation', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/search', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'Diet Cola', upc: '049000028911' }])
      });
    });
    await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Diet Cola',
          upc: '049000028911',
          servings: [{ name: 'can', quantity: 1, calories: 150, fat: 0, carbohydrates: 40, protein: 0 }]
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

    await goToIngredientSearch(page, 'my recipe');
    await page.fill('#input-search', 'zzz-nonexistent-local-query');
    await page.waitForTimeout(700);

    await page.locator('.search-row', { hasText: 'Diet Cola' }).click();

    await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
    await expect(page.locator('#servings-panel-title')).toHaveText('Ingredient Quantity');
    await expect(page.locator('#servings-food-name')).toHaveText('Diet Cola');

    await page.locator('#sk-center').click(); // confirm the ingredient
    await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
    var ingredientRow = page.locator('.recipe-ingredient-row', { hasText: 'Diet Cola' });
    await expect(ingredientRow).toBeVisible();
    // computeIngredientNutrients has no foods record to look up for this
    // ingredient — confirms its referenceServing fallback actually works,
    // not just that nothing throws (0 calories would pass either way).
    await expect(ingredientRow.locator('.food-row-calories')).toHaveText('150');

    // Never submitted to moderation, before or after confirming — /search +
    // /lookup-upc both already read from the vetted USDA-derived table.
    // Never creates a local foods record either — the ingredient carries
    // its own denormalized reference serving + upc instead (see
    // addServingAsRecipeIngredient/computeIngredientNutrients).
    expect(submitCalled).toBe(false);
    var foodsAfter = await page.evaluate(function () {
      return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
    });
    expect(foodsAfter.length).toBe(foodsBefore.length);
  });

  test('a remote result whose UPC already has a local mapping resolves straight to Ingredient Quantity, no /lookup-upc call', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/search', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'Banana, Raw (Store Brand)', upc: '000111222555' }])
      });
    });
    var lookupCalled = false;
    await page.route('https://api.calories.elliscode.com/lookup-upc', function (route) {
      lookupCalled = true;
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.evaluate(function () {
      return new Promise(function (resolve) {
        window.dbBulkPutUpcMappings([{
          upc: '000111222555',
          foodId: '8c8fa111-5908-5fe6-991f-382f19200095', // Banana, Raw (tests/fixtures/sample-foods.json)
          servingName: '1 medium',
          servingQuantity: 1
        }], resolve);
      });
    });

    await goToIngredientSearch(page, 'my recipe');
    await page.fill('#input-search', 'banana store brand');
    await page.waitForTimeout(700);

    await page.locator('.search-row', { hasText: 'Banana, Raw (Store Brand)' }).click();

    await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
    await expect(page.locator('#servings-panel-title')).toHaveText('Ingredient Quantity');
    // Resolves to the real local food's own name, not the remote row's display text.
    await expect(page.locator('#servings-food-name')).toHaveText('Banana, Raw');
    expect(lookupCalled).toBe(false);
  });
});

test('a response that arrives after the query has since changed is discarded, not inserted', async ({ page }) => {
  var resolveSearch;
  var searchResponse = new Promise(function (resolve) { resolveSearch = resolve; });
  await page.route('https://api.calories.elliscode.com/search', async function (route) {
    await searchResponse;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ name: 'Stale Result Food', upc: '000999888777' }])
    });
  });

  await page.fill('#input-search', 'firstquery');
  await page.waitForTimeout(600); // debounce fires, call starts and hangs

  await page.fill('#input-search', 'secondquery'); // query changes before the response lands
  await page.waitForTimeout(100);

  resolveSearch();
  await page.waitForTimeout(300);

  await expect(page.locator('.search-row', { hasText: 'Stale Result Food' })).toHaveCount(0);
});
