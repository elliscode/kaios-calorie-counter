const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });
  await page.route('https://api.calories.elliscode.com/sync/foods', function (route) { route.abort(); });
  await page.route('https://api.calories.elliscode.com/sync/preferences', function (route) { route.abort(); });
});

function todayStr() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

test('adding a diary entry triggers /sync/diary scoped to the current date', async ({ page }) => {
  var bodies = [];
  await page.route('https://api.calories.elliscode.com/sync/diary', function (route) {
    var body = route.request().postDataJSON();
    bodies.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: body.date, entries: {} }) });
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'Apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row').first().click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await expect.poll(function () { return bodies.length; }).toBeGreaterThan(0);
  var last = bodies[bodies.length - 1];
  expect(last.date).toBe(todayStr());
  var entryValues = Object.keys(last.entries).map(function (k) { return last.entries[k]; });
  expect(entryValues.some(function (e) { return e.foodName === 'Apple, Raw'; })).toBe(true);
});

test('navigating to a different date triggers a /sync/diary call scoped to that new date', async ({ page }) => {
  var dates = [];
  await page.route('https://api.calories.elliscode.com/sync/diary', function (route) {
    var body = route.request().postDataJSON();
    dates.push(body.date);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: body.date, entries: {} }) });
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await page.fill('#input-diary-date', '2026-01-15');

  await expect.poll(function () { return dates.indexOf('2026-01-15') !== -1; }).toBe(true);
});

test('deleting a diary entry removes it from the rendered list but reports it deleted on the next diary sync', async ({ page }) => {
  var bodies = [];
  await page.route('https://api.calories.elliscode.com/sync/diary', function (route) {
    var body = route.request().postDataJSON();
    bodies.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: body.date, entries: {} }) });
  });

  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'Apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row').first().click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row')).toHaveCount(1);

  bodies.length = 0; // only care about the sync triggered by the delete below
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.locator('#sk-right').click(); // Delete

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row')).toHaveCount(0);

  await expect.poll(function () { return bodies.length; }).toBeGreaterThan(0);
  var last = bodies[bodies.length - 1];
  var entryValues = Object.keys(last.entries).map(function (k) { return last.entries[k]; });
  expect(entryValues.length).toBeGreaterThan(0);
  expect(entryValues[0].deleted).toBe(true);
});
