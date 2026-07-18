const { test, expect } = require('@playwright/test');
const { mockDataHost } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

test('boots and shows an empty diary for today', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
  await expect(page.locator('#sum-calories')).toHaveText('0');
  await expect(page.locator('#sum-caffeine')).toHaveText('0');

  var today = new Date().toISOString().slice(0, 10);
  await expect(page.locator('#input-diary-date')).toHaveValue(today);
});

test('softkey bar is visible at KaiOS width and hidden above 240px', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#softkey')).toBeVisible();
  await expect(page.locator('#sk-left')).toHaveText('Search');
  await expect(page.locator('#sk-right')).toHaveText('Options');

  await page.setViewportSize({ width: 400, height: 600 });
  await expect(page.locator('#softkey')).toBeHidden();
});

test('works even if the data host is unreachable (offline-first)', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('https://calories.elliscode.com/**', function (route) {
    route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
});

test('an empty diary focuses "+ Add Food" first, not the date picker at the bottom', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#btn-diary-add-food')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#input-diary-date')).not.toHaveAttribute('nav-selected', 'true');
});

test('a diary with entries focuses the first food row first, not the date picker', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Log something so the diary is non-empty, then come back to it.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'SoftLeft' })));
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row').first()).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#btn-diary-add-food')).toHaveCount(0); // only exists when empty
  await expect(page.locator('#input-diary-date')).not.toHaveAttribute('nav-selected', 'true');
});
