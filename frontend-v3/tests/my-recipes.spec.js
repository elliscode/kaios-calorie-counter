const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

async function createSimpleRecipe(page, name) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', name);

  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Apple, Raw' }).first().click();
  await page.fill('#input-serving-qty', '50');
  await page.locator('#sk-center').click();

  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

async function goToMyRecipes(page) {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-my-recipes').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
}

test('a created recipe shows up in My Recipes with an ingredient count, not in My Foods', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createSimpleRecipe(page, 'My Test Recipe');

  await goToMyRecipes(page);
  await expect(page.locator('.my-recipe-row')).toHaveCount(1);
  await expect(page.locator('.my-recipe-row .options-label')).toHaveText('My Test Recipe');
  await expect(page.locator('.my-recipe-row .options-value')).toHaveText('1 ingredient');

  await pressSoftKey(page, 'SoftLeft'); // My Recipes -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-my-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
  await expect(page.locator('.my-food-row')).toHaveCount(0);
});

test('deleting a recipe removes it from the list and reports it deleted on the next foods sync', async ({ page }) => {
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });
  var syncFoodsBodies = [];
  await page.route('https://api.calories.elliscode.com/sync/foods', function (route) {
    syncFoodsBodies.push(route.request().postDataJSON());
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ foods: {} }) });
  });
  await page.route('https://api.calories.elliscode.com/sync/diary', function (route) { route.abort(); });
  await page.route('https://api.calories.elliscode.com/sync/preferences', function (route) { route.abort(); });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createSimpleRecipe(page, 'Deletable Recipe');
  var id = await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetAllFoods(function (foods) {
        var recipe = foods.filter(function (f) { return f.type === 'recipe'; })[0];
        resolve(recipe && recipe.id);
      });
    });
  });
  expect(id).toBeTruthy();

  await goToMyRecipes(page);
  await page.locator('.my-recipe-row').click();
  await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Options
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Delete' }).click();

  await expect(page.locator('.my-recipe-row')).toHaveCount(0);
  await expect(page.locator('#my-recipes-empty')).toBeVisible();

  await expect.poll(function () { return syncFoodsBodies.length; }).toBeGreaterThan(0);
  var lastBody = syncFoodsBodies[syncFoodsBodies.length - 1];
  expect(lastBody.foods[id]).toBeTruthy();
  expect(lastBody.foods[id].deleted).toBe(true);
  expect(lastBody.foods[id].type).toBe('recipe');
});

test('Edit opens the same builder pre-filled, updates the recipe in place, and never logs a second diary entry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createSimpleRecipe(page, 'Original Name');
  await expect(page.locator('#panel-diary .food-row')).toHaveCount(1); // the one entry from creation

  var id = await page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetAllFoods(function (foods) {
        var recipe = foods.filter(function (f) { return f.type === 'recipe'; })[0];
        resolve(recipe && recipe.id);
      });
    });
  });

  await goToMyRecipes(page);
  await page.locator('.my-recipe-row').click();
  await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Options
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Edit' }).click();

  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await expect(page.locator('#recipe-builder-title')).toHaveText('Edit Recipe');
  await expect(page.locator('#input-recipe-name')).toHaveValue('Original Name');
  await expect(page.locator('#input-recipe-servings-count')).toHaveValue('1');
  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(1);

  // Modify: rename, add a second ingredient, change the servings count.
  await page.fill('#input-recipe-name', 'Renamed Recipe');
  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'butter');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Butter' }).first().click();
  await page.selectOption('#input-serving-name', 'Tablespoon');
  await page.fill('#input-serving-qty', '1');
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await expect(page.locator('.recipe-ingredient-row')).toHaveCount(2);
  await page.fill('#input-recipe-servings-count', '2');

  await page.locator('#btn-recipe-submit').click();

  // Returns to My Recipes, not the Diary — editing never logs a new entry.
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
  await expect(page.locator('.my-recipe-row .options-label')).toHaveText('Renamed Recipe');
  await expect(page.locator('.my-recipe-row .options-value')).toHaveText('2 ingredients');

  // The underlying record actually changed, and it's still the same id.
  var recipe = await page.evaluate(function (recipeId) {
    return new Promise(function (resolve) { window.dbGetFood(recipeId, resolve); });
  }, id);
  expect(recipe.id).toBe(id);
  expect(recipe.name).toBe('Renamed Recipe');
  expect(recipe.ingredients.length).toBe(2);
  expect(recipe.servingsCount).toBe(2);

  // No second diary entry was logged by the edit.
  var todayEntries = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetDiaryByDate(window.todayStr(), resolve); });
  });
  expect(todayEntries.length).toBe(1);
});

test('Back while editing a recipe returns to My Recipes, not Search', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createSimpleRecipe(page, 'Back Test Recipe');

  await goToMyRecipes(page);
  await page.locator('.my-recipe-row').click();
  await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Options
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Edit' }).click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');

  await page.locator('#sk-left').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
});

test('a recipe synced down from another device does not leak into My Foods', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Simulate a /sync/foods response containing a recipe this device has
  // never seen before, run through the real merge/reconcile functions.
  await page.evaluate(function () {
    return new Promise(function (resolve) {
      var merged = {
        'fake-recipe-id-0000': {
          name: 'Synced Recipe', type: 'recipe',
          servings: [{ name: 'serving', quantity: 1, calories: 100, fat: 0, carbohydrates: 0, protein: 0 }],
          ingredients: [], servingsCount: 1,
          updated: Math.floor(Date.now() / 1000), deleted: false
        }
      };
      window.applyFoodsSyncMerge(merged, function () {
        window.reconcileMySubmissionsFromFoodsSync(merged, resolve);
      });
    });
  });

  await goToMyRecipes(page);
  await expect(page.locator('.my-recipe-row')).toHaveCount(1);
  await expect(page.locator('.my-recipe-row .options-label')).toHaveText('Synced Recipe');

  await pressSoftKey(page, 'SoftLeft'); // My Recipes -> Options
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-my-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
  await expect(page.locator('.my-food-row')).toHaveCount(0);

  var subs = await page.evaluate(function () {
    return new Promise(function (resolve) { window.dbGetAllMySubmissions(resolve); });
  });
  expect(subs.some(function (s) { return s.id === 'fake-recipe-id-0000'; })).toBe(false);
});
