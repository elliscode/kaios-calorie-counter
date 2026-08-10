const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  // No afterAddFood override — these tests exercise the app's own real
  // default ('modify'), unlike every other spec file (mockDataHost's
  // default 'direct' seed preserves their pre-existing instant-add
  // assumption regardless of what this setting now defaults to).
  await mockDataHost(page, { afterAddFood: null });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

// Robust to whichever mode is the current default — reads the row's current
// value rather than assuming a starting point, then clicks only if a toggle
// is actually needed to reach `mode`.
async function setAfterAddFood(page, mode) {
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  var desired = mode === 'modify' ? 'Modify servings' : 'Return to diary';
  var current = await page.locator('#opt-after-add-food-value').textContent();
  if (current !== desired) await page.locator('#opt-after-add-food').click();
  await pressSoftKey(page, 'SoftLeft'); // back to Diary
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

test('"After I add a food" is "Modify servings" by default, and toggling it persists across reload', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#opt-after-add-food-value')).toHaveText('Modify servings');

  await page.locator('#opt-after-add-food').click();
  await expect(page.locator('#opt-after-add-food-value')).toHaveText('Return to diary');

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#opt-after-add-food-value')).toHaveText('Return to diary');
});

test('default ("Modify servings"): adding a food from Search stops at a servings confirmation with no meal field', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-panel-title')).toHaveText('Add to Diary');
  await expect(page.locator('#sk-center')).toHaveText('Add');
  await expect(page.locator('#input-serving-qty')).toHaveValue('100'); // defaultServingForFood -> 'g'
  await expect(page.locator('#wrap-diary-meal')).not.toBeVisible();

  await page.fill('#input-serving-qty', '250');
  await page.locator('#sk-center').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
  await expect(page.locator('.food-row-serving')).toHaveText('250 g');
});

test('"Return to diary": adding a food from Search is instant, unaffected by the servings-confirmation flow (regression guard)', async ({ page }) => {
  await setAfterAddFood(page, 'direct');
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
});

test('"Modify servings": backing out of the confirmation adds nothing', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
});

test('"Modify servings" combined with mandatory meal selection: the meal field is still shown and still required', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-meals-enabled').click(); // Require Meal Selection defaults on
  await pressSoftKey(page, 'SoftLeft');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#wrap-diary-meal')).toBeVisible();

  // Blocked until a real meal is picked.
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await page.selectOption('#input-meal', 'lunch');
  await page.locator('#sk-center').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveText(['Lunch']);
});

test('"Modify servings": a multi-item Tray commit shows one confirmation per item, in sequence', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'banana');
  await page.waitForTimeout(250);

  var firstRowName = await page.locator('#search-ul .search-row').first().textContent();
  await page.keyboard.press('ArrowDown');
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('.status-toast')).toHaveText('Added to tray (1)');

  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  // First confirmation (the tray item) — accept it.
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.locator('#sk-center').click();

  // Second confirmation (Apple itself) — back out of this one.
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-food-name')).toHaveText('Apple, Raw');
  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Added 1 item');
  await expect(page.locator('.food-row-name')).toHaveText(firstRowName.trim());
});
