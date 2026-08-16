const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

async function goToMyRecipes(page) {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-my-recipes').click();
  await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
}

async function buildBaseRecipe(page) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'zzz-share-test');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await page.fill('#input-recipe-name', 'Apple Snack');
  await page.locator('#btn-recipe-add-ingredient').click();
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Apple, Raw' }).first().click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.selectOption('#input-serving-name', '1 medium');
  await page.fill('#input-serving-qty', '1');
  await page.locator('#sk-center').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');
  await page.fill('#input-recipe-servings-count', '1');
  await page.locator('#btn-recipe-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

test.describe('Recipe Detail screen and sharing', () => {
  test.beforeEach(async ({ page }) => {
    await mockDataHost(page);
    await page.goto('/');
    await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
    await buildBaseRecipe(page);
  });

  test('tapping a My Recipes row opens the detail screen with correct nutrition and ingredients', async ({ page }) => {
    await goToMyRecipes(page);

    await page.locator('.my-recipe-row', { hasText: 'Apple Snack' }).click();
    await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');
    await expect(page.locator('#recipe-detail-name')).toHaveText('Apple Snack');
    await expect(page.locator('#recipe-detail-calories')).toHaveText('95'); // Apple, Raw 1 medium
    await expect(page.locator('#recipe-detail-ingredients-ul')).toContainText('Apple, Raw');

    await expect(page.locator('#btn-recipe-share')).toBeVisible();
  });

  test('Options (right softkey) still reaches Edit/Delete via the existing action sheet', async ({ page }) => {
    await goToMyRecipes(page);
    await page.locator('.my-recipe-row', { hasText: 'Apple Snack' }).click();
    await expect(page.locator('#panel-recipe-detail')).toHaveAttribute('active', 'true');

    await page.locator('#sk-right').click();
    await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
    await expect(page.locator('#sheet-ul .list-row')).toHaveText(['Edit', 'Delete', 'Cancel']);

    await page.locator('#sheet-ul .list-row', { hasText: 'Delete' }).click();
    // Deleting from the detail screen navigates back to the list, not a stale detail view.
    await expect(page.locator('#panel-my-recipes')).toHaveAttribute('active', 'true');
    await expect(page.locator('.my-recipe-row', { hasText: 'Apple Snack' })).toHaveCount(0);
  });

  test('Share button posts a fully-denormalized payload and opens the SMS/Email sheet', async ({ page }) => {
    var shareRequestBody = null;
    await page.route('https://api.calories.elliscode.com/recipes/share', function (route) {
      shareRequestBody = route.request().postDataJSON();
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'testshareid123456789' }) });
    });

    await goToMyRecipes(page);
    await page.locator('.my-recipe-row', { hasText: 'Apple Snack' }).click();
    await page.locator('#btn-recipe-share').click();

    await expect.poll(function () { return shareRequestBody; }).toBeTruthy();
    expect(shareRequestBody.name).toBe('Apple Snack');
    expect(shareRequestBody.ingredients).toEqual([
      {
        foodName: 'Apple, Raw', servingName: '1 medium', quantity: 1,
        referenceServing: { name: '1 medium', quantity: 1, calories: 95, fat: 0.3, carbohydrates: 25, protein: 0.5, caffeine: 0, fiber: 4.4, sugars: 19 }
      }
    ]);

    await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
    await expect(page.locator('#sheet-title')).toHaveText('Apple Snack');
    await expect(page.locator('#sheet-ul .list-row')).toHaveText(['Text Message', 'Email', 'Cancel']);
  });
});

test.describe('Opening a shared-recipe link', () => {
  test.beforeEach(async ({ page }) => {
    await mockDataHost(page);
  });

  test('non-KaiOS: ?share=<id> imports the recipe and logs it to the diary, without any local catalog dependency', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/recipes/shared', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Shared Chili',
          servings: [{ name: 'serving', quantity: 1, calories: 300, fat: 10, carbohydrates: 30, protein: 20 }],
          servingsCount: 4,
          ingredients: [
            { foodName: 'Mystery Beans', servingName: 'cup', quantity: 2, referenceServing: { name: 'cup', quantity: 1, calories: 100, fat: 0, carbohydrates: 20, protein: 7 } }
          ]
        })
      });
    });

    await page.goto('/?share=abc123sharetest');
    await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
    await expect(page.locator('.status-toast')).toHaveText('Added Shared Chili');
    await expect(page.locator('.food-row-name')).toHaveText('Shared Chili');
    await expect(page.locator('.food-row-calories')).toHaveText('300');
  });

  test('non-KaiOS: ?share=<id>&handoff=1 imports the recipe but shows the full-screen success banner instead of the Diary panel', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/recipes/shared', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Handoff Recipe',
          servings: [{ name: 'serving', quantity: 1, calories: 200, fat: 5, carbohydrates: 20, protein: 10 }],
          servingsCount: 1,
          ingredients: [
            { foodName: 'Thing', servingName: 'g', quantity: 100, referenceServing: { name: 'g', quantity: 100, calories: 200, fat: 5, carbohydrates: 20, protein: 10 } }
          ]
        })
      });
    });

    await page.goto('/?share=handofftest1&handoff=1');
    await expect(page.locator('#share-handoff-banner')).toHaveAttribute('active', 'true');
    await expect(page.locator('#share-handoff-banner')).toContainText('Added "Handoff Recipe" to your diary');
    await expect(page.locator('#panel-diary')).not.toHaveAttribute('active', 'true');
  });

  test('KaiOS UA at a non-.localhost origin shows the "click to add" banner instead of booting normally', async ({ page, browser }) => {
    var context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Mobile; LYF/F90M/... KAIOS/2.5.4) Gecko/48.0 Firefox/48.0 KAIOS/2.5' });
    var kaiosPage = await context.newPage();
    await mockDataHost(kaiosPage);
    await kaiosPage.route('https://api.calories.elliscode.com/recipes/shared', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'KaiOS Banner Recipe',
          servings: [{ name: 'serving', quantity: 1, calories: 150, fat: 2, carbohydrates: 15, protein: 5 }],
          servingsCount: 1,
          ingredients: [{ foodName: 'X', servingName: 'g', quantity: 100, referenceServing: { name: 'g', quantity: 100, calories: 150, fat: 2, carbohydrates: 15, protein: 5 } }]
        })
      });
    });

    await kaiosPage.goto('/?share=kaiosbannertest');
    await expect(kaiosPage.locator('#share-handoff-banner')).toHaveAttribute('active', 'true');
    await expect(kaiosPage.locator('#share-handoff-banner')).toContainText('Click here to add the "KaiOS Banner Recipe" recipe to your diary');
    var href = await kaiosPage.locator('#share-handoff-banner').getAttribute('href');
    expect(href).toBe('http://caloriecounter.localhost/index.html?share=kaiosbannertest&handoff=1');
    // Normal bootstrap never ran — panel-loading is still active by default
    // (it paints before any script runs, see index.html's own comment on
    // it), just visually covered by the fullscreen banner on top of it.
    await expect(kaiosPage.locator('#panel-loading')).toHaveAttribute('active', 'true');
    await expect(kaiosPage.locator('#panel-diary')).not.toHaveAttribute('active', 'true');

    await context.close();
  });

  test('opening the same share link twice does not create a second recipe or a second diary entry', async ({ page }) => {
    await page.route('https://api.calories.elliscode.com/recipes/shared', function (route) {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Repeat Import Recipe',
          servings: [{ name: 'serving', quantity: 1, calories: 120, fat: 1, carbohydrates: 10, protein: 3 }],
          servingsCount: 1,
          ingredients: [{ foodName: 'Y', servingName: 'g', quantity: 100, referenceServing: { name: 'g', quantity: 100, calories: 120, fat: 1, carbohydrates: 10, protein: 3 } }]
        })
      });
    });

    await page.goto('/?share=repeattest1');
    await expect(page.locator('.status-toast')).toHaveText('Added Repeat Import Recipe');
    var foodsAfterFirst = await page.evaluate(function () {
      return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
    });
    var diaryCountAfterFirst = await page.locator('.food-row').count();

    await page.goto('/?share=repeattest1'); // same id again, fresh page load
    await expect(page.locator('.status-toast')).toHaveText('You already added this recipe');

    var foodsAfterSecond = await page.evaluate(function () {
      return new Promise(function (resolve) { window.dbGetAllFoods(resolve); });
    });
    expect(foodsAfterSecond.filter(function (f) { return f.name === 'Repeat Import Recipe'; }).length).toBe(1);
    expect(foodsAfterFirst.filter(function (f) { return f.name === 'Repeat Import Recipe'; }).length).toBe(1);

    var diaryCountAfterSecond = await page.locator('.food-row').count();
    expect(diaryCountAfterSecond).toBe(diaryCountAfterFirst); // no second diary entry logged
  });
});
