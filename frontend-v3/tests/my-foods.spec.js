const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

async function createFood(page, name) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', name);
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'serving');
  await page.fill('#input-new-food-calories', '100');
  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

async function goToMyFoods(page) {
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-my-foods').click();
  await expect(page.locator('#panel-my-foods')).toHaveAttribute('active', 'true');
}

function getMySubmissionId(page) {
  return page.evaluate(function () {
    return new Promise(function (resolve) {
      window.dbGetAllMySubmissions(function (subs) { resolve(subs[0] && subs[0].id); });
    });
  });
}

test('deleting a food removes it from the list and reports it deleted on the next foods sync', async ({ page }) => {
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    var body = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.id }) });
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
  await createFood(page, 'to be deleted');
  var id = await getMySubmissionId(page);

  await goToMyFoods(page);
  await page.locator('.my-food-row').click();
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Delete' }).click();

  await expect(page.locator('.my-food-row')).toHaveCount(0);
  await expect(page.locator('#my-foods-empty')).toBeVisible();

  await expect.poll(function () { return syncFoodsBodies.length; }).toBeGreaterThan(0);
  var lastBody = syncFoodsBodies[syncFoodsBodies.length - 1];
  expect(lastBody.foods[id].deleted).toBe(true);
});
