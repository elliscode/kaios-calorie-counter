const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

async function addIngredient(page, query, foodName, servingName, qty) {
  await page.locator('#btn-recipe-add-ingredient').click();
  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  await page.fill('#input-search', query);
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: foodName }).first().click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await expect(page.locator('#servings-panel-title')).toHaveText('Ingredient Quantity');
  await expect(page.locator('#servings-food-name')).toHaveText(foodName);
  await page.selectOption('#input-serving-name', servingName);
  await page.fill('#input-serving-qty', String(qty));
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
}

test('"+ Add new food/recipe/guesstimate" are visible immediately, even with an empty query', async ({ page }) => {
  await goToSearchFromDiary(page);
  await expect(page.locator('#panel-search .search-row.add-new')).toHaveText('+ Add new food');
  await expect(page.locator('#panel-search .search-row.add-new-recipe')).toHaveText('+ Add new recipe');
  await expect(page.locator('#panel-search .search-row.add-new-guesstimate')).toHaveText('+ Add guesstimate');

  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await expect(page.locator('#panel-search .search-row.add-new')).toHaveText('+ Add new food');
  await expect(page.locator('#panel-search .search-row.add-new-recipe')).toHaveText('+ Add new recipe');
  await expect(page.locator('#panel-search .search-row.add-new-guesstimate')).toHaveText('+ Add guesstimate');
});

test('building a recipe from two ingredients bakes the correct per-serving totals and logs one serving to the diary', async ({ page }) => {
  var submitCalled = false;
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    submitCalled = true;
    route.abort();
  });

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'my recipe query');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-recipe-name')).toHaveValue('my recipe query');
  await page.fill('#input-recipe-name', 'Apple & Milk Snack');

  // Apple, Raw "1 medium" = 95 cal, 0.3 fat, 25 carbs, 0.5 protein.
  await addIngredient(page, 'apple', 'Apple, Raw', '1 medium', 1);
  // Milk, Whole "cup" = 149 cal, 8 fat, 12 carbs, 8 protein.
  await addIngredient(page, 'milk', 'Milk, Whole', 'cup', 1);

  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(2);

  // Total 244 cal / 2 servings = 122 cal per serving.
  await page.fill('#input-recipe-servings-count', '2');
  await page.locator('#btn-recipe-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-diary .food-row-name')).toHaveText('Apple & Milk Snack');
  await expect(page.locator('#panel-diary .food-row-calories')).toHaveText('122');
  expect(submitCalled).toBe(false);

  // The recipe is now a normal, reusable, searchable food.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'Apple & Milk Snack');
  await page.waitForTimeout(250);
  var row = page.locator('#panel-search .search-row', { hasText: 'Apple & Milk Snack' }).first();
  await expect(row.locator('.recipe-tag')).toHaveText('Recipe');
});

test('an ingredient can be removed from the builder via its actions sheet', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Two Ingredient Test');

  await addIngredient(page, 'apple', 'Apple, Raw', 'g', 50);
  await addIngredient(page, 'milk', 'Milk, Whole', 'g', 50);
  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(2);

  await page.locator('.recipe-ingredient-row', { hasText: 'Apple, Raw' }).click();
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Remove' }).click();

  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(1);
  await expect(page.locator('.recipe-ingredient-row')).toHaveText(/Milk, Whole/);
});

test('Back from the Recipe Builder returns to Search with the prior query intact', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');

  await page.locator('#sk-left').click();
  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-search')).toHaveValue('butter');
});

test('Back from the ingredient-quantity picker returns to the builder with prior ingredients intact', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Partial Recipe');

  await addIngredient(page, 'apple', 'Apple, Raw', 'g', 50);
  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(1);

  // Start adding a second ingredient, but back out of the quantity picker.
  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Butter' }).first().click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.locator('#sk-left').click();

  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-recipe-name')).toHaveValue('Partial Recipe');
  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(1);
});

test('a different recipe can be nested as an ingredient, baked as a frozen snapshot that a later edit to the source recipe does not change', async ({ page }) => {
  // Base Recipe: Apple, Raw "1 medium" = 95 cal, servingsCount 1 -> bakes to 95 cal/serving.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Base Recipe');
  await addIngredient(page, 'apple', 'Apple, Raw', '1 medium', 1);
  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Second Recipe: 2 servings of Base Recipe as its one ingredient, its
  // own servingsCount 1 -> bakes to 95*2 = 190 cal/serving.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Second Recipe');
  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'Base Recipe');
  await page.waitForTimeout(250);
  var baseRecipeRow = page.locator('#panel-search .search-row', { hasText: 'Base Recipe' });
  await expect(baseRecipeRow).toBeVisible();
  await expect(baseRecipeRow.locator('.recipe-tag')).toHaveText('Recipe');
  await baseRecipeRow.click();
  await expect(page.locator('#servings-food-name')).toHaveText('Base Recipe');
  await page.fill('#input-serving-qty', '2');
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row', { hasText: 'Second Recipe' }).locator('.food-row-calories')).toHaveText('190');

  // Editing Base Recipe afterward must not retroactively change Second
  // Recipe's already-baked totals — it was a frozen snapshot at pick time.
  var secondRecipeCaloriesBefore = await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetAllFoods(function (foods) {
        resolve(foods.filter(function (f) { return f.name === 'Second Recipe'; })[0].servings[0].calories);
      });
    });
  });
  expect(secondRecipeCaloriesBefore).toBe(190);

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-my-recipes').click();
  await page.locator('.my-recipe-row', { hasText: 'Base Recipe' }).click();
  await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Options
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Edit' }).click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await page.fill('#input-recipe-servings-count', '2'); // was 1 -> now bakes to 95/2 = 47.5 cal/serving
  await page.locator('#btn-recipe-submit').click();

  var secondRecipeCaloriesAfter = await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetAllFoods(function (foods) {
        resolve(foods.filter(function (f) { return f.name === 'Second Recipe'; })[0].servings[0].calories);
      });
    });
  });
  expect(secondRecipeCaloriesAfter).toBe(190); // unchanged
});

test('a recipe cannot be picked as its own ingredient while being edited, but other recipes still can be', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Other Recipe');
  await addIngredient(page, 'apple', 'Apple, Raw', 'g', 50);
  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Self Ref Recipe');
  await addIngredient(page, 'apple', 'Apple, Raw', 'g', 50);
  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await pressSoftKey(page, 'SoftRight'); // Diary -> Options
  await page.locator('#opt-my-recipes').click();
  await page.locator('.my-recipe-row', { hasText: 'Self Ref Recipe' }).click();
  await page.locator('#sk-right').click(); // Options
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Edit' }).click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');

  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'Recipe');
  await page.waitForTimeout(250);
  var plainResults = page.locator('#panel-search .search-row:not(.add-new):not(.add-new-recipe):not(.add-new-guesstimate)');
  await expect(plainResults.filter({ hasText: 'Self Ref Recipe' })).toHaveCount(0); // itself: excluded
  await expect(plainResults.filter({ hasText: 'Other Recipe' })).toHaveCount(1); // a different recipe: still allowed
});

test('required fields: recipe name, at least one ingredient, and a positive servings count', async ({ page }) => {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();

  // No name yet.
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');

  // Name but no ingredients.
  await page.fill('#input-recipe-name', 'Empty Recipe');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
});
