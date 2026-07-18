const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('right softkey on Diary opens Options, showing the app version', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-left')).toHaveText('Back');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#opt-version')).not.toBeEmpty();
});

test('left softkey on Options returns to Diary', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});
