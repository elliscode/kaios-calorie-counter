const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

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
  await expect(page.locator('#sk-left')).toHaveText(''); // Search softkey removed — "+ Add Food" is primary now
  await expect(page.locator('#sk-center')).toHaveText('Add'); // "+ Add Food" has default focus
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

test('"+ Add Food" stays first/focused even on a day with entries, ahead of the food list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Log something so the diary is non-empty, then come back to it.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  // "+ Add Food" is always present and always first, regardless of entries.
  await expect(page.locator('#btn-diary-add-food')).toHaveCount(1);
  await expect(page.locator('#btn-diary-add-food')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('.food-row').first()).not.toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#input-diary-date')).not.toHaveAttribute('nav-selected', 'true');

  // The first food row is one Down-arrow away, right after "+ Add Food".
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.food-row').first()).toHaveAttribute('nav-selected', 'true');
});
