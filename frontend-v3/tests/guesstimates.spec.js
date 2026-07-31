const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

async function addGuesstimate(page, name, calories) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzzznonexistentquery');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-guesstimate').click();
  await expect(page.locator('#panel-guesstimate')).toHaveAttribute('active', 'true');
  await page.fill('#input-guesstimate-name', name);
  await page.fill('#input-guesstimate-calories', String(calories));
  await page.locator('#btn-guesstimate-submit').click();
}

test('submitting logs a diary entry with foodId:null and type:guesstimate, never touches /submit or /sync/foods', async ({ page }) => {
  var submitCalled = false;
  var syncFoodsCalled = false;
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    submitCalled = true;
    route.abort();
  });
  await page.route('https://api.calories.elliscode.com/sync/foods', function (route) {
    syncFoodsCalled = true;
    route.abort();
  });

  await addGuesstimate(page, 'Bar nachos w/ chicken kinda like the mexican place we usually go', '1250');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Bar nachos w/ chicken kinda like the mexican place we usually go');
  await expect(page.locator('.food-row-calories')).toHaveText('1250');

  var entries = await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetDiaryByDate(window.todayStr(), resolve);
    });
  });
  expect(entries.length).toBe(1);
  expect(entries[0].foodId).toBeNull();
  expect(entries[0].type).toBe('guesstimate');
  expect(entries[0].fat).toBe(0);
  expect(entries[0].carbohydrates).toBe(0);
  expect(entries[0].protein).toBe(0);

  expect(submitCalled).toBe(false);
  expect(syncFoodsCalled).toBe(false);
});

test('name and calories are both required', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzzznonexistentquery');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-guesstimate').click();
  await page.locator('#btn-guesstimate-submit').click();
  await expect(page.locator('#panel-guesstimate')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');
});

test('opening a guesstimate diary row shows correct values with no bogus guid/updated/type nutrient rows', async ({ page }) => {
  await addGuesstimate(page, 'Mystery snack', '300');
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-panel-title')).toHaveText('Edit Serving');
  await expect(page.locator('#servings-food-name')).toHaveText('Mystery snack');
  await expect(page.locator('#serv-calories')).toHaveText('300');

  var nutrientsText = await page.locator('#servings-nutrients').textContent();
  expect(nutrientsText).not.toMatch(/guid/i);
  expect(nutrientsText).not.toMatch(/updated/i);
  expect(nutrientsText).not.toMatch(/deleted/i);
  expect(nutrientsText.toLowerCase()).not.toContain('type');
});

test('Save works with an unchanged quantity (regression: used to always error "Could not save")', async ({ page }) => {
  await addGuesstimate(page, 'Mystery snack', '300');
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).not.toContainText('Could not save');
  await expect(page.locator('.food-row-calories')).toHaveText('300');
});

test('Save with a doubled quantity scales the calorie guess linearly', async ({ page }) => {
  await addGuesstimate(page, 'Mystery snack', '300');
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.fill('#input-serving-qty', '2');
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-calories')).toHaveText('600');
});

test('Delete works on a guesstimate entry', async ({ page }) => {
  await addGuesstimate(page, 'Mystery snack', '300');
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Delete
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row')).toHaveCount(0);
});

test('a guesstimate never appears in search afterward', async ({ page }) => {
  await addGuesstimate(page, 'Totally unique guess name xyz', '300');
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'Totally unique guess name xyz');
  await page.waitForTimeout(250);
  var plainResults = page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)');
  await expect(plainResults).toHaveCount(0);
});
