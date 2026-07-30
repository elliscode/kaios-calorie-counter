const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('caffeine row is hidden by default', async ({ page }) => {
  await expect(page.locator('#row-sum-caffeine')).not.toBeVisible();
});

test('toggling Show Caffeine on shows it on Diary and Servings, and persists across reload', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('#opt-show-caffeine-value')).toHaveText('Off');

  await page.locator('#opt-show-caffeine').click();
  await expect(page.locator('#opt-show-caffeine-value')).toHaveText('On');

  await pressSoftKey(page, 'SoftLeft'); // back to Diary
  await expect(page.locator('#row-sum-caffeine')).toBeVisible();

  // Add a food and check the Servings panel too.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#row-serv-caffeine')).toBeVisible();

  // Persists across a reload (same origin/storage).
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#row-sum-caffeine')).toBeVisible();

  // Toggling back off hides it again.
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-show-caffeine').click();
  await expect(page.locator('#opt-show-caffeine-value')).toHaveText('Off');
  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#row-sum-caffeine')).not.toBeVisible();
});
