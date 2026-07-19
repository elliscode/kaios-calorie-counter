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
