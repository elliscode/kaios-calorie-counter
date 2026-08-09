const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

async function enableMeals(page) {
  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-meals-enabled').click();
  await pressSoftKey(page, 'SoftLeft'); // back to Diary
  // showDiaryPanel()'s render is an async IndexedDB round-trip — must be
  // awaited before proceeding, or a subsequent SoftRight can fire while
  // still (momentarily) on Options and be silently ignored (no right-
  // softkey action defined there), same reasoning every other spec's
  // navigation already follows.
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

// ─── Settings round-trip ────────────────────────────────────────────────────

test('Meals is off by default, and its dependent rows are hidden', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#opt-meals-enabled-value')).toHaveText('Off');
  await expect(page.locator('#opt-meals')).not.toBeVisible();
  await expect(page.locator('#opt-require-meal-selection')).not.toBeVisible();
});

test('enabling Meals reveals the dependent rows, Require Meal Selection defaults on, and it persists across reload', async ({ page }) => {
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-meals-enabled').click();
  await expect(page.locator('#opt-meals-enabled-value')).toHaveText('On');
  await expect(page.locator('#opt-meals')).toBeVisible();
  await expect(page.locator('#opt-require-meal-selection')).toBeVisible();
  await expect(page.locator('#opt-require-meal-selection-value')).toHaveText('On');

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#opt-meals-enabled-value')).toHaveText('On');
});

// ─── Meal CRUD + reorder ────────────────────────────────────────────────────

test('default meals are Breakfast/Lunch/Dinner/Snacks, in that order', async ({ page }) => {
  await enableMeals(page);
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-meals').click();
  await expect(page.locator('#panel-meals')).toHaveAttribute('active', 'true');
  await expect(page.locator('.meal-row')).toHaveText(['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
});

test('add, rename, reorder, and delete a meal', async ({ page }) => {
  await enableMeals(page);
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-meals').click();

  // Add.
  await page.locator('#btn-meals-add').click();
  await expect(page.locator('#panel-meal-edit')).toHaveAttribute('active', 'true');
  await page.fill('#input-meal-name', 'Second Breakfast');
  await page.locator('#btn-meal-edit-save').click();
  await expect(page.locator('#panel-meals')).toHaveAttribute('active', 'true');
  await expect(page.locator('.meal-row')).toHaveText(['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Second Breakfast']);
  await expect(page.locator('#opt-meals-count')).toBeHidden(); // count only shows back on Options

  // Rename.
  await page.locator('.meal-row', { hasText: 'Second Breakfast' }).click();
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row', { hasText: 'Rename' }).click();
  await expect(page.locator('#panel-meal-edit')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-meal-name')).toHaveValue('Second Breakfast');
  await page.fill('#input-meal-name', 'Brunch');
  await page.locator('#btn-meal-edit-save').click();
  await expect(page.locator('.meal-row')).toHaveText(['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Brunch']);

  // Move Up twice -> Brunch ends up right after Breakfast.
  await page.locator('.meal-row', { hasText: 'Brunch' }).click();
  await page.locator('#sheet-ul .list-row', { hasText: 'Move Up' }).click();
  await page.locator('.meal-row', { hasText: 'Brunch' }).click();
  await page.locator('#sheet-ul .list-row', { hasText: 'Move Up' }).click();
  await page.locator('.meal-row', { hasText: 'Brunch' }).click();
  await page.locator('#sheet-ul .list-row', { hasText: 'Move Up' }).click();
  await expect(page.locator('.meal-row')).toHaveText(['Breakfast', 'Brunch', 'Lunch', 'Dinner', 'Snacks']);

  // Delete.
  await page.locator('.meal-row', { hasText: 'Brunch' }).click();
  await page.locator('#sheet-ul .list-row', { hasText: 'Delete' }).click();
  await expect(page.locator('#sheet-title')).toHaveText('Delete meal?');
  await page.locator('#sheet-ul .list-row', { hasText: 'Yes, delete' }).click();
  await expect(page.locator('.meal-row')).toHaveText(['Breakfast', 'Lunch', 'Dinner', 'Snacks']);

  await pressSoftKey(page, 'SoftLeft'); // back to Options
  await expect(page.locator('#opt-meals-count')).toHaveText('4');
});

// ─── Diary grouping ─────────────────────────────────────────────────────────

async function seedGuesstimates(page, date, entries) {
  await page.evaluate(function (args) {
    return new Promise(function (resolve) {
      var remaining = args.entries.length;
      args.entries.forEach(function (e) {
        dbAddDiaryEntry({
          date: args.date, foodId: null, foodName: e.name, servingName: 'guess', quantity: 1,
          calories: 100, fat: 0, carbohydrates: 0, protein: 0, type: 'guesstimate',
          guid: e.name, updated: e.createdAt, createdAt: e.createdAt, mealId: e.mealId, deleted: false
        }, function () { remaining--; if (remaining === 0) resolve(); });
      });
    });
  }, { date: date, entries: entries });
}

test('diary groups entries by meal, in Meals-manager order, with an Other group for unassigned and dangling meal ids', async ({ page }) => {
  await enableMeals(page);
  var today = await page.locator('#input-diary-date').inputValue();

  await seedGuesstimates(page, today, [
    { name: 'Toast', createdAt: 100, mealId: 'breakfast' },
    { name: 'Sandwich', createdAt: 200, mealId: 'lunch' },
    { name: 'Mystery Snack', createdAt: 300, mealId: null },
    { name: 'Ghost Meal Item', createdAt: 400, mealId: 'does-not-exist' }
  ]);

  await page.reload();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await expect(page.locator('.diary-group-header')).toHaveText(['Breakfast', 'Lunch', 'Other']);
  await expect(page.locator('.food-row-name')).toHaveText(['Toast', 'Sandwich', 'Mystery Snack', 'Ghost Meal Item']);
});

test('diary is a flat list with no group headers when Meals is off (regression guard)', async ({ page }) => {
  var today = await page.locator('#input-diary-date').inputValue();
  await seedGuesstimates(page, today, [
    { name: 'Toast', createdAt: 100, mealId: 'breakfast' },
    { name: 'Sandwich', createdAt: 200, mealId: null }
  ]);
  await page.reload();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveCount(0);
  await expect(page.locator('.food-row-name')).toHaveText(['Toast', 'Sandwich']);
});

// ─── Confirmation gate: search-add (food-object-backed) ────────────────────

test('mandatory: adding a food from search stops at a serving+meal confirmation', async ({ page }) => {
  await enableMeals(page); // Require Meal Selection defaults on
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-panel-title')).toHaveText('Add to Diary');
  await expect(page.locator('#sk-center')).toHaveText('Add');
  await expect(page.locator('#input-serving-qty')).toHaveValue('100'); // defaultServingForFood -> 'g'
  await expect(page.locator('#wrap-diary-meal')).toBeVisible();

  // Blocked until a real meal is picked.
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await page.selectOption('#input-meal', 'lunch');
  await page.locator('#sk-center').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveText(['Lunch']);
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
});

test('mandatory: backing out of the confirmation adds nothing', async ({ page }) => {
  await enableMeals(page);
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftLeft');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
});

test('skippable: turning off Require Meal Selection restores instant add (Other group)', async ({ page }) => {
  await enableMeals(page);
  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-require-meal-selection').click();
  await expect(page.locator('#opt-require-meal-selection-value')).toHaveText('Off');
  await pressSoftKey(page, 'SoftLeft');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  // No confirmation panel — lands straight on Diary, same as today.
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveText(['Other']);
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
});

test('Meals disabled entirely: quick add is untouched (regression guard)', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Apple, Raw');
  await expect(page.locator('.food-row-serving')).toHaveText('100 g');
  await expect(page.locator('#sum-calories')).toHaveText('52');
});

// ─── Confirmation gate: Guesstimate (inline-form-backed) ────────────────────

test('mandatory: Guesstimate requires a meal before it can submit', async ({ page }) => {
  await enableMeals(page);
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz-nonexistent');
  await page.waitForTimeout(250);
  await page.locator('.search-row.add-new-guesstimate').click();
  await expect(page.locator('#panel-guesstimate')).toHaveAttribute('active', 'true');
  await expect(page.locator('#wrap-guesstimate-meal')).toBeVisible();

  await page.fill('#input-guesstimate-name', 'Mystery snack');
  await page.fill('#input-guesstimate-calories', '300');
  await page.locator('#btn-guesstimate-submit').click();

  // Still blocked — placeholder is still selected.
  await expect(page.locator('#panel-guesstimate')).toHaveAttribute('active', 'true');

  await page.selectOption('#input-guesstimate-meal', 'snacks');
  await page.locator('#btn-guesstimate-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveText(['Snacks']);
});

test('mandatory: Guesstimate can still be explicitly submitted to Other', async ({ page }) => {
  await enableMeals(page);
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz-nonexistent');
  await page.waitForTimeout(250);
  await page.locator('.search-row.add-new-guesstimate').click();
  await page.fill('#input-guesstimate-name', 'Mystery snack');
  await page.fill('#input-guesstimate-calories', '300');
  await page.selectOption('#input-guesstimate-meal', ''); // explicit "Other"
  await page.locator('#btn-guesstimate-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.diary-group-header')).toHaveText(['Other']);
});

test('Meals disabled entirely: Guesstimate is untouched (regression guard)', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz-nonexistent');
  await page.waitForTimeout(250);
  await page.locator('.search-row.add-new-guesstimate').click();
  await expect(page.locator('#wrap-guesstimate-meal')).not.toBeVisible();
  await page.fill('#input-guesstimate-name', 'Mystery snack');
  await page.fill('#input-guesstimate-calories', '300');
  await page.locator('#btn-guesstimate-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('Mystery snack');
});

// ─── Tray multi-item mandatory case ─────────────────────────────────────────

test('mandatory: a multi-item Tray commit shows one confirmation per item, in sequence', async ({ page }) => {
  await enableMeals(page);
  await goToSearchFromDiary(page);
  // #btn-diary-add-food (a different panel entirely) also carries the
  // .search-row class for shared styling, so this must stay scoped to
  // #search-ul — an unscoped .search-row query would match that button
  // first (DOM order, regardless of which panel is actually visible).
  await page.fill('#input-search', 'banana');
  await page.waitForTimeout(250);

  // Queue Banana via Tray (SoftRight on the focused first result), then
  // commit the batch by picking a second item.
  await page.keyboard.press('ArrowDown');
  var firstRowName = await page.locator('#search-ul .search-row').first().textContent();
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('.status-toast')).toHaveText('Added to tray (1)');

  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  // First confirmation (the tray item).
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.selectOption('#input-meal', 'breakfast');
  await page.locator('#sk-center').click();

  // Second confirmation (Apple itself) — back out of this one.
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-food-name')).toHaveText('Apple, Raw');
  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveText('Added 1 item');
  await expect(page.locator('.food-row-name')).toHaveText(firstRowName.trim());
});
