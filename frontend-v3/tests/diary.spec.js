const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

test('boots and shows an empty diary for today', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
  await expect(page.locator('#sum-calories')).toHaveText('0');
  await expect(page.locator('#sum-caffeine')).toHaveText('0');

  // Mirrors app.js's own todayStr() (local date components) rather than
  // toISOString() (UTC) -- the two disagree for several hours a day
  // depending on timezone, which made this test flaky near the UTC
  // day boundary.
  var now = new Date();
  var today = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
  await expect(page.locator('#input-diary-date')).toHaveValue(today);
});

test('softkey bar is visible at KaiOS width and hidden above 240px', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#softkey')).toBeVisible();
  await expect(page.locator('#sk-left')).toHaveText(''); // Search softkey removed — "+ Add Food" is primary now
  await expect(page.locator('#sk-center')).toHaveText('Add'); // "+ Add Food" has default focus
  await expect(page.locator('#sk-right')).toHaveText('Options');

  await page.setViewportSize({ width: 400, height: 600 });
  await expect(page.locator('#softkey')).toBeHidden();
});

test('works even if the data host is unreachable (offline-first)', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('https://calories.elliscode.com/**', function (route) {
    route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#diary-empty')).toBeVisible();
});

test('an empty diary focuses "+ Add Food" first, not the date picker at the bottom', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#btn-diary-add-food')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#input-diary-date')).not.toHaveAttribute('nav-selected', 'true');
});

test('"+ Add Food" stays first/focused even on a day with entries, ahead of the food list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Log something so the diary is non-empty, then come back to it.
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row', { hasText: 'Apple, Raw' }).click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  // "+ Add Food" is always present and always first, regardless of entries.
  await expect(page.locator('#btn-diary-add-food')).toHaveCount(1);
  await expect(page.locator('#btn-diary-add-food')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('.food-row').first()).not.toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#input-diary-date')).not.toHaveAttribute('nav-selected', 'true');

  // The first food row is one Down-arrow away, right after "+ Add Food".
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.food-row').first()).toHaveAttribute('nav-selected', 'true');
});

// Seeds entries directly via the app's own dbAddDiaryEntry (exposed on
// window since app.js runs unbundled) with explicit createdAt values, out
// of insertion order — proves the render sort actually keys off createdAt
// and not IndexedDB insertion/autoincrement order, which real same-second
// UI clicks couldn't reliably distinguish.
async function seedGuesstimates(page, date, entries) {
  await page.evaluate(function (args) {
    return new Promise(function (resolve) {
      var remaining = args.entries.length;
      args.entries.forEach(function (e) {
        dbAddDiaryEntry({
          date: args.date, foodId: null, foodName: e.name, servingName: 'guess', quantity: 1,
          calories: 100, fat: 0, carbohydrates: 0, protein: 0, type: 'guesstimate',
          guid: e.name, updated: e.createdAt, createdAt: e.createdAt, deleted: false
        }, function () { remaining--; if (remaining === 0) resolve(); });
      });
    });
  }, { date: date, entries: entries });
}

test('diary entries are sorted oldest-added-first, not by insertion order', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  var today = await page.locator('#input-diary-date').inputValue();

  // Inserted in this order (Last, First, Middle) so id/insertion order would
  // read Last/First/Middle if the sort were wrong -- createdAt order is
  // First/Middle/Last.
  await seedGuesstimates(page, today, [
    { name: 'Added Last', createdAt: 300 },
    { name: 'Added First', createdAt: 100 },
    { name: 'Added Middle', createdAt: 200 }
  ]);

  await page.reload();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText(['Added First', 'Added Middle', 'Added Last']);
});

test('editing an entry does not change its position in the list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  var today = await page.locator('#input-diary-date').inputValue();

  await seedGuesstimates(page, today, [
    { name: 'First Logged', createdAt: 100 },
    { name: 'Second Logged', createdAt: 200 }
  ]);

  await page.reload();
  await expect(page.locator('.food-row-name')).toHaveText(['First Logged', 'Second Logged']);

  // Editing bumps `updated` to right now, far later than "Second Logged"'s
  // createdAt=200 -- if the sort used `updated` (or if the edit path failed
  // to preserve createdAt), this would jump to the bottom.
  await page.locator('.food-row', { hasText: 'First Logged' }).click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  await page.fill('#input-serving-qty', '2');
  await page.keyboard.press('Enter');

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText(['First Logged', 'Second Logged']);
});
