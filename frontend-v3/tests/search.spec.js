const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('"+ Add Food" on Diary opens Search', async ({ page }) => {
  await goToSearchFromDiary(page);
  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
});

test('quick add: clicking a result commits it with the default g serving', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);

  var row = page.locator('.search-row', { hasText: 'Apple, Raw' });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
  await expect(page.locator('.food-row-serving')).toHaveText('100 g');
  await expect(page.locator('#sum-calories')).toHaveText('52');
});

test('left softkey abandons the tray and returns to Diary', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'a');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown'); // focus first result
  await pressSoftKey(page, 'SoftRight'); // queue it in the tray

  await pressSoftKey(page, 'SoftLeft'); // back out
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible(); // tray was discarded, nothing added
});

test('tray: queue multiple foods with right softkey, commit them all with center/Enter', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'a'); // matches Apple, Banana, Butter Organic, Chicken Sandwich, Coffee
  await page.waitForTimeout(250);

  // No usage history yet, so results are purely alphabetical: Apple, Banana, ...
  await page.keyboard.press('ArrowDown'); // focus 1st result (Apple, Raw)
  await pressSoftKey(page, 'SoftRight'); // queue it
  await expect(page.locator('#sk-center')).toHaveText('Add (2)');

  await page.keyboard.press('ArrowDown'); // focus 2nd result (Banana, Raw)
  await page.keyboard.press('Enter'); // commit focused + tray

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  var names = await page.locator('.food-row-name').allTextContents();
  expect(names.sort()).toEqual(['Apple, Raw', 'Banana, Raw']);
  await expect(page.locator('#sum-calories')).toHaveText('141'); // 52 (apple@100g) + 89 (banana@100g)
});

test('search ignores punctuation — "apple raw" (no comma) still matches "Apple, Raw"', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple raw');
  await page.waitForTimeout(250);

  await expect(page.locator('.search-row', { hasText: 'Apple, Raw' })).toBeVisible();
});

test('token-based search: "hershey special dark" matches "Hershey\'s Special Dark" (plain substring match would miss it — the extra "s" from the apostrophe is in the way)', async ({ page }) => {
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
  await page.fill('#input-search', 'hershey special dark');
  await page.waitForTimeout(250);
  await expect(page.locator('.search-row', { hasText: "Hershey's Special Dark" })).toBeVisible();
});

test('token-based search: word order does not matter — "dark hershey" still matches "Hershey\'s Special Dark"', async ({ page }) => {
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
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'dark hershey');
  await page.waitForTimeout(250);
  await expect(page.locator('.search-row', { hasText: "Hershey's Special Dark" })).toBeVisible();
});

test('results are ranked by match closeness — a tight match outranks a longer name diluted by extra words', async ({ page }) => {
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbBulkPutFoods([
        {
          id: 'test-hersheys-tight-id',
          name: "Hershey's Special Dark",
          source: 'catalog',
          updated: Math.floor(Date.now() / 1000),
          deleted: false,
          servings: [{ name: 'bar', quantity: 1, calories: 180, fat: 12, carbohydrates: 20, protein: 2 }]
        },
        {
          id: 'test-hersheys-loose-id',
          name: "Betty Crocker, Hersheys, Special Dark Premium Frosting",
          source: 'catalog',
          updated: Math.floor(Date.now() / 1000),
          deleted: false,
          servings: [{ name: 'serving', quantity: 1, calories: 140, fat: 5, carbohydrates: 22, protein: 0 }]
        }
      ], resolve);
    });
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'hershey special dark');
  await page.waitForTimeout(250);

  var names = await page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)').allTextContents();
  expect(names).toEqual(["Hershey's Special Dark", 'Betty Crocker, Hersheys, Special Dark Premium Frosting']);
});
