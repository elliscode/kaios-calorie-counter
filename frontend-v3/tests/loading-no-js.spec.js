const { test, expect } = require('@playwright/test');

// The actual scenario this feature exists for: a slow device where JS hasn't
// even started running yet (parsing/executing app.js, opening IndexedDB, the
// network round-trip to the manifest — all before a single pixel changes).
// Disabling JS entirely is the most direct way to prove the loading panel +
// spinner come from plain HTML/CSS, not from a script that hasn't run yet.
test.use({ javaScriptEnabled: false });

test('the loading panel and spinner are visible from markup/CSS alone, with no JS executed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-loading')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-loading')).toBeVisible();
  await expect(page.locator('.lds-spinner')).toBeVisible();
  await expect(page.locator('.loading-heading')).toHaveText('Loading…');

  // Every other panel must still be inactive/hidden without JS ever running.
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'false');
  await expect(page.locator('#panel-diary')).toBeHidden();
});
