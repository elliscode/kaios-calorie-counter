const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('Clear Local DB opens a confirmation sheet with the expected copy', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-clear-db').click();

  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sheet-title')).toHaveText('Clear local database?');
  await expect(page.locator('#sheet-note')).toHaveText(
    'Are you sure you want to clear the local database? All diary entries, custom foods, and recipes will be deleted permanently.'
  );

  var rows = page.locator('#sheet-ul .list-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText('Yes, delete the local DB');
  await expect(rows.nth(1)).toHaveText('No, do not delete');
});

test('"No, do not delete" closes the sheet and keeps existing data', async ({ page }) => {
  // Log something first so we have data to prove survives.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-clear-db').click();
  await page.locator('#sheet-ul .list-row', { hasText: 'No, do not delete' }).click();

  await expect(page.locator('#sheet')).toHaveAttribute('active', 'false');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftLeft'); // back to Diary
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
});

test('"Yes, delete the local DB" wipes IndexedDB and reloads to an empty app', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-clear-db').click();

  await Promise.all([
    page.waitForNavigation(),
    page.locator('#sheet-ul .list-row', { hasText: 'Yes, delete the local DB' }).click()
  ]);

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
  await expect(page.locator('#sum-calories')).toHaveText('0');
});
