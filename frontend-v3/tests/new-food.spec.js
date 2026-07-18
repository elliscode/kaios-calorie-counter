const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  // The real submit API doesn't exist yet — let it fail/abort, proving the
  // feature doesn't depend on it succeeding.
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftLeft'); // Diary -> Search
});

test('"+ Add new food" is the only row when a search has zero matches', async ({ page }) => {
  await page.fill('#input-search', 'zzzznonexistentfood');
  await page.waitForTimeout(250);

  var rows = page.locator('#panel-search .search-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText('+ Add new food');
});

test('"+ Add new food" is still the last row even when there are real matches', async ({ page }) => {
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);

  var rows = page.locator('#panel-search .search-row');
  await expect(rows.last()).toHaveText('+ Add new food');
  var count = await rows.count();
  expect(count).toBeGreaterThan(1);
});

test('submitting the form logs a diary entry, works offline (API not built yet), and the food becomes searchable', async ({ page }) => {
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-new-food-name')).toHaveValue('protein muffin');

  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'muffin');
  await page.fill('#input-new-food-calories', '310');
  await page.fill('#input-new-food-fat', '9');
  await page.fill('#input-new-food-carbs', '40');
  await page.fill('#input-new-food-protein', '20');

  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('protein muffin');
  await expect(page.locator('.food-row-serving')).toHaveText('1 muffin');
  await expect(page.locator('.food-row-calories')).toHaveText('310');
  await expect(page.locator('#sum-calories')).toHaveText('310');
  await expect(page.locator('#sum-fat')).toHaveText('9');
  await expect(page.locator('#sum-protein')).toHaveText('20');

  // Now searchable again this session (proves the local foods cache + state.allFoods updated).
  await pressSoftKey(page, 'SoftLeft');
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await expect(page.locator('.search-row', { hasText: 'protein muffin' })).toBeVisible();
});

test('required fields: submitting without calories shows an error and adds nothing', async ({ page }) => {
  await page.fill('#input-search', 'mystery snack');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();

  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'bar');
  // Calories left blank on purpose.
  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');
});

test('left softkey discards the form and returns to Search with its prior results intact', async ({ page }) => {
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  await page.fill('#input-new-food-name', 'should be discarded');
  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-search')).toHaveValue('apple');
  await expect(page.locator('.search-row', { hasText: 'Apple, Raw' })).toBeVisible();
});
