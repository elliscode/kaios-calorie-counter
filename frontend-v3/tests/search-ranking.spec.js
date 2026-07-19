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

  var names = await page.locator('#panel-search .search-row:not(.add-new)').allTextContents();
  expect(names).toEqual(['Butter', 'Butter, Organic', 'Whipped Butter']);
});

test('a frequently-logged food ranks above alphabetically-earlier matches, per the user\'s own example', async ({ page }) => {
  for (var i = 0; i < 6; i++) {
    await quickAdd(page, 'Whipped Butter');
  }

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);

  var names = await page.locator('#panel-search .search-row:not(.add-new)').allTextContents();
  expect(names).toEqual(['Whipped Butter', 'Butter', 'Butter, Organic']);
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

  var names = await page.locator('#panel-search .search-row:not(.add-new)').allTextContents();
  expect(names).toEqual(['Butter', 'Butter, Organic', 'Whipped Butter']); // back to alphabetical
});
