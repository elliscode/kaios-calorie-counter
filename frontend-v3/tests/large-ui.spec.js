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

test.describe('diary row swipe-to-delete', () => {
  test.use({ viewport: { width: 241, height: 700 }, hasTouch: true });

  test('dragging a diary row left reveals Delete; tapping it removes the entry', async ({ page }) => {
    await goToSearchFromDiary(page);
    await page.fill('#input-search', 'apple');
    await page.waitForTimeout(250);
    await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
    await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
    await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

    var box = await page.locator('.food-row').boundingBox();

    await page.evaluate(function (box) {
      var el = document.querySelector('.food-row');
      function touchAt(x, y) {
        return new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      }
      var y = box.y + box.height / 2;
      var startX = box.x + box.width - 10;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touchAt(startX, y)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touchAt(startX - 80, y)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    }, box);

    await expect(page.locator('#diary-row-delete-reveal')).toBeVisible();
    await page.locator('#diary-row-delete-reveal').click();

    await expect(page.locator('#diary-empty')).toBeVisible();
    await expect(page.locator('.food-row')).toHaveCount(0);
  });

  test('a short drag that stays below the reveal threshold snaps back closed, and tapping the row still opens Servings', async ({ page }) => {
    await goToSearchFromDiary(page);
    await page.fill('#input-search', 'apple');
    await page.waitForTimeout(250);
    await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
    await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');

    var box = await page.locator('.food-row').boundingBox();

    await page.evaluate(function (box) {
      var el = document.querySelector('.food-row');
      function touchAt(x, y) {
        return new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      }
      var y = box.y + box.height / 2;
      var startX = box.x + box.width - 10;
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touchAt(startX, y)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touchAt(startX - 20, y)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    }, box);

    await expect(page.locator('#diary-row-delete-reveal')).toBeHidden();

    await page.locator('.food-row').click();
    await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  });
});
