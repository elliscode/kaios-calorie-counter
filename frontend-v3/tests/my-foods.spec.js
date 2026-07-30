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

test('a food created while logged out shows as Local', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createFood(page, 'my custom snack');

  await goToMyFoods(page);
  await expect(page.locator('.my-food-row')).toHaveCount(1);
  await expect(page.locator('.my-food-row .options-label')).toHaveText('my custom snack');
  await expect(page.locator('.my-food-row .my-food-status-local')).toHaveText('Local');
});

test('a food created while logged in with a successful /submit shows Approval Pending', async ({ page }) => {
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    var body = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.id }) });
  });
  await page.route('https://api.calories.elliscode.com/sync/**', function (route) { route.abort(); });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createFood(page, 'logged in snack');

  await goToMyFoods(page);
  await expect.poll(async function () {
    return page.locator('.my-food-status-pending').count();
  }).toBe(1);
  await expect(page.locator('.my-food-status-pending')).toHaveText('Approval Pending');
});

test('a food whose id shows up via catalog sync (source: catalog) displays as Approved', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createFood(page, 'soon to be approved');
  var id = await getMySubmissionId(page);
  expect(id).toBeTruthy();

  // Simulate what a real catalog sync does once this food has actually been
  // approved+exported and shows up in a downloaded manifest data file under
  // its own id (see syncData()'s dbBulkPutFoods call, which tags source:
  // 'catalog' the same way).
  await page.evaluate(function (foodId) {
    return new Promise(function (resolve) {
      window.dbGetFood(foodId, function (food) {
        food.source = 'catalog';
        window.dbBulkPutFoods([food], resolve);
      });
    });
  }, id);

  await goToMyFoods(page);
  await expect(page.locator('.my-food-status-approved')).toHaveText('Approved');
});

test('a still-pending submission older than 30 days displays as Rejected', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createFood(page, 'stale submission');
  var id = await getMySubmissionId(page);

  await page.evaluate(function (foodId) {
    return new Promise(function (resolve) {
      var THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;
      window.dbPutMySubmission({
        id: foodId,
        createdAt: Math.floor(Date.now() / 1000) - THIRTY_ONE_DAYS,
        submittedAt: Math.floor(Date.now() / 1000) - THIRTY_ONE_DAYS,
        submitStatus: 'pending'
      }, resolve);
    });
  }, id);

  await goToMyFoods(page);
  await expect(page.locator('.my-food-status-rejected')).toHaveText('Rejected');
});

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

test('re-submit only flips status to Approval Pending on a genuine 200, stays Local on a 403', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await createFood(page, 'retry candidate'); // created logged-out -> stays Local

  // Now behave as a logged-in session for the re-submit action itself.
  await page.evaluate(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });

  var shouldSucceed = false;
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    if (shouldSucceed) {
      var body = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.id }) });
    } else {
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Your session has expired, please log in' }) });
    }
  });
  await page.route('https://api.calories.elliscode.com/sync/**', function (route) { route.abort(); });

  await goToMyFoods(page);
  await page.locator('.my-food-row').click();
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Re-submit for approval' }).click();

  await expect(page.locator('.status-toast')).toHaveText(/still Local/);
  await expect(page.locator('.my-food-status-local')).toHaveText('Local');

  shouldSucceed = true;
  await page.locator('.my-food-row').click();
  await page.locator('#sheet-ul .list-row').filter({ hasText: 'Re-submit for approval' }).click();

  await expect(page.locator('.my-food-status-pending')).toHaveText('Approval Pending');
});
