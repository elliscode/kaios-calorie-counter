const { test, expect } = require('@playwright/test');
const path = require('path');

test('shows the loading panel with file count/name/progress while syncing, then Diary', async ({ page }) => {
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/manifest.json') });
  });
  // Deliberately slow this one down so the loading panel is observable
  // instead of the (tiny, local) fixture resolving before we can assert on it.
  await page.route('https://calories.elliscode.com/sample-foods.json', async function (route) {
    await new Promise(function (r) { setTimeout(r, 500); });
    route.fulfill({ path: path.join(__dirname, 'fixtures/sample-foods.json') });
  });

  await page.goto('/');

  await expect(page.locator('#panel-loading')).toHaveAttribute('active', 'true');
  await expect(page.locator('#loading-count')).toHaveText('Loading 1 of 1 database files…');
  await expect(page.locator('#loading-filename')).toHaveText('sample-foods.json');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true', { timeout: 5000 });
  await expect(page.locator('#panel-loading')).toHaveAttribute('active', 'false');
  await expect(page.locator('#loading-progress-fill')).toHaveCSS('width', /.+/); // fill was set at some point
});

test('does not show the loading panel again once everything is already synced', async ({ page }) => {
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/manifest.json') });
  });
  await page.route('https://calories.elliscode.com/sample-foods.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/sample-foods.json') });
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Re-navigate on the same page/context — IndexedDB (and its syncedFiles
  // record) persists, so this second launch should skip straight to Diary.
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-loading')).not.toHaveAttribute('active', 'true');
});
