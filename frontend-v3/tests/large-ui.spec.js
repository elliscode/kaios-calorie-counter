const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

// The >240px touchscreen UI foundation — see the "Phase 1: large-width
// (>240px) touchscreen UI foundation" plan. #btn-scan-upc/panel-scan-result
// (see scan.spec.js) already established 241px as this app's "large width"
// test convention.
test.use({ viewport: { width: 241, height: 700 } });

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('the status toast sits under the header, not at the bottom (iOS keyboard/bottom-nav would otherwise hide it)', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Every search-row click commits through the tray/batch path
  // (commitFoodAndTray), even for a single item — "Added 1 item", not the
  // food's name (see e.g. tests/after-add-food.spec.js's own toast checks).
  var toast = page.locator('.status-toast');
  await expect(toast).toHaveText('Added 1 item');
  var box = await toast.boundingBox();
  // Below the header (min-height:56px, see header.css) and nowhere near
  // the bottom of the 700px-tall test viewport.
  expect(box.y).toBeGreaterThan(50);
  expect(box.y).toBeLessThan(150);
});

test('#softkey is hidden, and #topbar-back/#topbar-accept mirror what the softkey labels would have been', async ({ page }) => {
  await expect(page.locator('#softkey')).toBeHidden();

  // Diary: handleSoftLeft has no case for it (Back stays empty) and
  // #sk-center's switch doesn't special-case it either (no Accept action).
  await expect(page.locator('#topbar-back')).toBeHidden();
  await expect(page.locator('#topbar-accept')).toBeHidden();

  // Search: both #sk-left ("Back") and #sk-center ("Add"/"Tray" label) are
  // real actions there.
  await goToSearchFromDiary(page);
  await expect(page.locator('#topbar-back')).toBeVisible();
  await expect(page.locator('#topbar-accept')).toBeVisible();
});

test('#topbar-accept stays hidden on Diary even when a row is auto-focused on load (not a real "commit" action there)', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // A fresh load with an existing entry: #btn-diary-add-food is hidden at
  // this width, so showPanel()'s auto-focus lands on the food row itself
  // (#sk-center's underlying label really is "Edit" — confirming this
  // isn't a coincidentally-empty-label case), yet the top-bar checkmark
  // should never show for it — tapping the row already does the same thing.
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row')).toHaveCount(1);
  await expect(page.locator('#sk-center')).toHaveText('Edit');
  await expect(page.locator('#topbar-accept')).toBeHidden();
});

test('#topbar-accept stays hidden on every plain list/tap panel (Options, My Foods, My Recipes, Foods & Recipes, Meals)', async ({ page }) => {
  // Options.
  await page.locator('#btn-bottom-nav-settings').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#topbar-accept')).toBeHidden();

  // Meals (enable it first — its Options row is hidden otherwise).
  await page.locator('#opt-meals-enabled').click();
  await page.locator('#opt-meals').click();
  await expect(page.locator('#panel-meals')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#topbar-accept')).toBeHidden();
  await page.locator('#topbar-back').click();
  await page.locator('#topbar-back').click(); // Options -> Diary

  // Foods & Recipes chooser, and My Foods / My Recipes beneath it.
  await page.locator('#btn-bottom-nav-foods').click();
  await expect(page.locator('#panel-foods-recipes')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#topbar-accept')).toBeHidden();

  await page.locator('#btn-foods-recipes-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#topbar-accept')).toBeHidden();
  await page.locator('#topbar-back').click();

  await page.locator('#btn-foods-recipes-recipes').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sk-center')).toHaveText('SELECT');
  await expect(page.locator('#topbar-accept')).toBeHidden();
});

test('Diary bottom nav: Add opens Search, Settings opens Options, My Foods opens the Foods & Recipes chooser', async ({ page }) => {
  await expect(page.locator('#diary-bottom-nav')).toBeVisible();
  await expect(page.locator('#btn-diary-add-food')).toBeHidden();

  await page.locator('#btn-bottom-nav-add').click();
  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('#btn-bottom-nav-settings').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('#btn-bottom-nav-foods').click();
  await expect(page.locator('#panel-foods-recipes')).toHaveAttribute('active', 'true');
});

test('the Foods & Recipes chooser opens the existing My Foods/My Recipes panels unchanged, and Back returns to the chooser', async ({ page }) => {
  await page.locator('#btn-bottom-nav-foods').click();
  await expect(page.locator('#panel-foods-recipes')).toHaveAttribute('active', 'true');

  await page.locator('#btn-foods-recipes-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-foods-recipes')).toHaveAttribute('active', 'true');

  await page.locator('#btn-foods-recipes-recipes').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-foods-recipes')).toHaveAttribute('active', 'true');
});

test('Back from My Foods/My Recipes still returns to Options when reached the old way (regression guard)', async ({ page }) => {
  await page.locator('#btn-bottom-nav-settings').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');

  await page.locator('#opt-my-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');

  await page.locator('#opt-my-recipes').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
  await page.locator('#topbar-back').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
});

test('arrow-key highlight is absent on load and only appears after an arrow key is pressed', async ({ page }) => {
  // showOptionsPanel() reliably auto-focuses its first row via
  // showPanel()'s first-visible-nav-selectable logic — unlike search
  // results, which are never auto-focused (only ArrowDown moves onto one).
  await page.locator('#btn-bottom-nav-settings').click();
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  var firstRow = page.locator('.options-row').first();

  // Focused (nav-selected="true") via setFocus() on render, but not
  // visually highlighted yet — body.using-keyboard hasn't been set.
  await expect(firstRow).toHaveAttribute('nav-selected', 'true');
  await expect(firstRow).not.toHaveCSS('background-color', 'rgb(56, 142, 60)');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(firstRow).toHaveCSS('background-color', 'rgb(56, 142, 60)');
});

test('at 240px (KaiOS width) the highlight is always visible regardless of prior input', async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 294 });
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  var firstRow = page.locator('.options-row').first();
  await expect(firstRow).toHaveCSS('background-color', 'rgb(56, 142, 60)');
});

test('#btn-servings-delete is the >240px on-screen equivalent of #sk-right\'s Delete, and only shows for a real diary entry', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#btn-servings-delete')).toBeVisible();

  await page.locator('#btn-servings-delete').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Deleted');
  await expect(page.locator('.food-row')).toHaveCount(0);
});

test('#btn-servings-delete is hidden when panel-servings has no real diary entry backing it (recipe-ingredient mode)', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz-nonexistent');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');

  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#btn-servings-delete')).toBeHidden();
});

