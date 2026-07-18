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
