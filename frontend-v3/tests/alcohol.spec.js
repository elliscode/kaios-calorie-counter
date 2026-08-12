const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('alcohol row is hidden by default', async ({ page }) => {
  await expect(page.locator('#row-sum-alcohol')).not.toBeVisible();
});

test('toggling Show Alcohol on shows it on Diary, Servings, and Recipes, and persists across reload', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('#opt-show-alcohol-value')).toHaveText('Off');

  await page.locator('#opt-show-alcohol').click();
  await expect(page.locator('#opt-show-alcohol-value')).toHaveText('On');

  await pressSoftKey(page, 'SoftLeft'); // back to Diary
  await expect(page.locator('#row-sum-alcohol')).toBeVisible();

  // Add a food and check the Servings panel too.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#row-serv-alcohol')).toBeVisible();

  // Persists across a reload (same origin/storage).
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#row-sum-alcohol')).toBeVisible();

  // Toggling back off hides it again.
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-show-alcohol').click();
  await expect(page.locator('#opt-show-alcohol-value')).toHaveText('Off');
  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#row-sum-alcohol')).not.toBeVisible();
});

test('a food with alcohol shows it as a proper whole-number "g" row, not in the dynamic nutrient table, and Diary sums it correctly', async ({ page }) => {
  // No fixture food carries an alcohol value — inject one directly, same
  // technique tests/my-foods.spec.js's catalog-sync test already uses.
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbBulkPutFoods([{
        id: 'test-wine-id',
        name: 'Wine, Red',
        source: 'catalog',
        updated: Math.floor(Date.now() / 1000),
        deleted: false,
        servings: [{ name: 'glass', quantity: 1, calories: 125, fat: 0, carbohydrates: 4, protein: 0.1, alcohol: 12.3 }]
      }], resolve);
    });
  });
  // Reload so state.allFoods (populated once at boot) picks up the new food.
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-show-alcohol').click();
  await pressSoftKey(page, 'SoftLeft');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'wine');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Wine, Red' }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#row-serv-alcohol')).toBeVisible();
  await expect(page.locator('#serv-alcohol')).toHaveText('12'); // Math.round(12.3), not round2's "12.3"

  // Not duplicated into the generic dynamic nutrient table below.
  await expect(page.locator('#servings-nutrients')).not.toContainText('Alcohol');

  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sum-alcohol')).toHaveText('12');
});
