const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

// Deliberately its own file rather than added to remote-search.spec.js —
// that file's shared beforeEach already calls goToSearchFromDiary before
// each test body runs, which would fire (and swallow) the exact warm call
// these tests need to observe.
test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('opening Search from Diary fires a warm request to /search', async ({ page }) => {
  var calls = [];
  await page.route('https://api.calories.elliscode.com/search', function (route) {
    calls.push(route.request().postDataJSON());
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ warmed: true }) });
  });

  await goToSearchFromDiary(page);
  await page.waitForTimeout(100);

  expect(calls).toEqual([{ action: 'warm' }]);
});

test('opening Search for a recipe ingredient also fires a warm request to /search', async ({ page }) => {
  var calls = [];
  await page.route('https://api.calories.elliscode.com/search', function (route) {
    calls.push(route.request().postDataJSON());
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ warmed: true }) });
  });

  await goToSearchFromDiary(page); // diary-mode warm call — not what's under test here
  await page.waitForTimeout(100);
  await page.fill('#input-search', 'my recipe');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new-recipe').click();
  await expect(page.locator('#panel-recipe-builder')).toHaveAttribute('active', 'true');

  calls.length = 0; // isolate to just the warm call fired by opening ingredient search below
  await page.locator('#btn-recipe-add-ingredient').click();
  await page.waitForTimeout(100);

  expect(calls).toEqual([{ action: 'warm' }]);
});

test('a warm call in flight blocks the first real search debounce from firing until it settles', async ({ page }) => {
  var calls = [];
  var resolveWarm;
  var warmResponse = new Promise(function (resolve) { resolveWarm = resolve; });

  await page.route('https://api.calories.elliscode.com/search', async function (route) {
    var body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === 'warm') await warmResponse; // hold the warm call open
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(body.action === 'warm' ? { warmed: true } : [])
    });
  });

  await goToSearchFromDiary(page); // fires the warm call, which hangs open
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(600); // the 500ms real-search debounce would normally fire here

  // searchInProgress is still held by the in-flight warm call, so the
  // debounce fire for 'apple' was dropped rather than queued — same
  // "drop, don't queue" tradeoff two real searches already have between
  // each other.
  expect(calls).toEqual([{ action: 'warm' }]);

  resolveWarm();
  await page.waitForTimeout(100);

  // A fresh keystroke once warm has settled is free to fire for real.
  await page.fill('#input-search', 'apple2');
  await page.waitForTimeout(600);
  expect(calls).toEqual([{ action: 'warm' }, { query: 'apple2' }]);
});
