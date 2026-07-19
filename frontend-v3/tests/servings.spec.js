const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

async function quickAddApple(page) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await quickAddApple(page);
});

test('opening a diary row shows its current serving and nutrient breakdown', async ({ page }) => {
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-title')).toHaveText('Apple, Raw');
  await expect(page.locator('#input-serving-qty')).toHaveValue('100');
  await expect(page.locator('#input-serving-name')).toHaveValue('g');
  await expect(page.locator('#serv-calories')).toHaveText('52');

  // A nutrient present on the food but not part of the Diary summary
  // (fiber) should show up generically in the breakdown below.
  await expect(page.locator('#servings-nutrients')).toContainText('Fiber');
});

test('editing quantity recalculates live and Save persists it back to the Diary', async ({ page }) => {
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await page.fill('#input-serving-qty', '150');
  await expect(page.locator('#serv-calories')).toHaveText('78'); // 52 * 1.5

  await page.keyboard.press('Enter'); // dedicated qty-input listener -> saveServingsEdit()

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-serving')).toHaveText('150 g');
  await expect(page.locator('.food-row-calories')).toHaveText('78');
  await expect(page.locator('#sum-calories')).toHaveText('78');
});

test('right softkey deletes the entry', async ({ page }) => {
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftRight');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
  await expect(page.locator('#sum-calories')).toHaveText('0');
});

test('left softkey / Back discards edits without saving', async ({ page }) => {
  await page.locator('.food-row').click();
  await page.fill('#input-serving-qty', '999');

  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-serving')).toHaveText('100 g');
});
