const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

async function quickAdd(page, foodName) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', foodName);
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: foodName }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('with no usage history, matching foods fall back to alphabetical order', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);

  var names = await page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)').allTextContents();
  expect(names).toEqual(['Butter', 'Butter, Organic', 'Whipped Butter']);
});

test('usage count only breaks ties between equally-close matches — an exact single-word match always wins outright', async ({ page }) => {
  // "Butter" (1 unique word) is a strictly tighter match for "butter" than
  // either "Whipped Butter" or "Butter, Organic" (2 unique words each) —
  // searchMatchScore ranks it first regardless of usage count. Between the
  // two equally-scored 2-word names, usage count still decides: logging
  // "Whipped Butter" 6x should move it above the never-logged
  // "Butter, Organic", without ever displacing "Butter" itself.
  for (var i = 0; i < 6; i++) {
    await quickAdd(page, 'Whipped Butter');
  }

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);

  var names = await page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)').allTextContents();
  expect(names).toEqual(['Butter', 'Whipped Butter', 'Butter, Organic']);
});

test('deleting a logged entry decrements its usage count back down', async ({ page }) => {
  await quickAdd(page, 'Whipped Butter');

  await page.locator('.food-row', { hasText: 'Whipped Butter' }).click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftRight'); // Delete
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);

  var names = await page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)').allTextContents();
  expect(names).toEqual(['Butter', 'Butter, Organic', 'Whipped Butter']); // back to alphabetical
});
