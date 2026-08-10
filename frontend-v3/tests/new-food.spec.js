const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  // The real submit API doesn't exist yet — let it fail/abort, proving the
  // feature doesn't depend on it succeeding.
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
});

test('"+ Add new food", "+ Add new recipe", and "+ Add guesstimate" are the only rows when a search has zero matches', async ({ page }) => {
  await page.fill('#input-search', 'zzzznonexistentfood');
  await page.waitForTimeout(250);

  var rows = page.locator('#panel-search .search-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText('+ Add new food');
  await expect(rows.nth(1)).toHaveText('+ Add new recipe');
  await expect(rows.nth(2)).toHaveText('+ Add guesstimate');
});

test('the three "+ Add..." rows are still last, in order, even when there are real matches', async ({ page }) => {
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);

  var rows = page.locator('#panel-search .search-row');
  var count = await rows.count();
  expect(count).toBeGreaterThan(3);
  await expect(rows.nth(count - 3)).toHaveText('+ Add new food');
  await expect(rows.nth(count - 2)).toHaveText('+ Add new recipe');
  await expect(rows.nth(count - 1)).toHaveText('+ Add guesstimate');
});

test('submitting the form logs a diary entry, works offline (API not built yet), and the food becomes searchable', async ({ page }) => {
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-new-food-name')).toHaveValue('protein muffin');

  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'muffin');
  await page.fill('#input-new-food-calories', '310');
  await page.fill('#input-new-food-fat', '9');
  await page.fill('#input-new-food-carbs', '40');
  await page.fill('#input-new-food-protein', '20');

  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('protein muffin');
  await expect(page.locator('.food-row-serving')).toHaveText('1 muffin');
  await expect(page.locator('.food-row-calories')).toHaveText('310');
  await expect(page.locator('#sum-calories')).toHaveText('310');
  await expect(page.locator('#sum-fat')).toHaveText('9');
  await expect(page.locator('#sum-protein')).toHaveText('20');

  // Now searchable again this session (proves the local foods cache + state.allFoods updated).
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await expect(page.locator('.search-row', { hasText: 'protein muffin' })).toBeVisible();
});

test('required fields: submitting without calories shows an error and adds nothing', async ({ page }) => {
  await page.fill('#input-search', 'mystery snack');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();

  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'bar');
  // Calories left blank on purpose.
  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');
});

test('center/Enter steps through fields ("Next") and only submits from the Submit button ("Submit")', async ({ page }) => {
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  // Starts on Name, softkey says "Next", not "Submit".
  await expect(page.locator('#input-new-food-name')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Next');

  await page.locator('#input-new-food-name').fill('protein muffin');
  await page.locator('#input-new-food-name').press('Enter');
  await expect(page.locator('#input-new-food-serving-qty')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Next');

  // Pressing Enter on a field must never submit by itself.
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  await page.locator('#input-new-food-serving-qty').fill('1');
  await page.locator('#input-new-food-serving-qty').press('Enter');
  await expect(page.locator('#input-new-food-serving-name')).toHaveAttribute('nav-selected', 'true');

  await page.locator('#input-new-food-serving-name').fill('muffin');
  await page.locator('#input-new-food-serving-name').press('Enter');
  await expect(page.locator('#input-new-food-calories')).toHaveAttribute('nav-selected', 'true');

  await page.locator('#input-new-food-calories').fill('310');
  await page.locator('#input-new-food-calories').press('Enter');
  await expect(page.locator('#input-new-food-fat')).toHaveAttribute('nav-selected', 'true');

  await page.locator('#input-new-food-fat').fill('9');
  await page.locator('#input-new-food-fat').press('Enter');
  await expect(page.locator('#input-new-food-carbs')).toHaveAttribute('nav-selected', 'true');

  await page.locator('#input-new-food-carbs').fill('40');
  await page.locator('#input-new-food-carbs').press('Enter');
  await expect(page.locator('#input-new-food-protein')).toHaveAttribute('nav-selected', 'true');

  await page.locator('#input-new-food-protein').fill('20');
  await page.locator('#input-new-food-protein').press('Enter');
  // Submit is now the very next stop, right after Protein — the advanced/
  // optional stuff (extra servings, UPC) comes after it, not before, so
  // the default path for most people is just Submit.
  await expect(page.locator('#btn-new-food-submit')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Submit');
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  // Arrow past Submit onto "Add additional serving" — back to "Next".
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#btn-add-extra-serving')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Next');
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  // Arrow past that onto the (optional) UPC field — still "Next", still hasn't submitted.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#input-new-food-upc')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Next');
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  // One more stop: a second Submit button at the very bottom, so anyone who
  // scrolled this far doesn't have to scroll all the way back up.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#btn-new-food-submit-bottom')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#sk-center')).toHaveText('Submit');

  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-name')).toHaveText('protein muffin');
});

test('clicking a field moves the virtual cursor there too, so Enter advances from it, not from wherever it last was', async ({ page }) => {
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-new-food-name')).toHaveAttribute('nav-selected', 'true');

  // Click straight into Calories, well past Name/Qty/Serving — skipping the
  // keyboard entirely, the way a mouse/touch user actually would.
  await page.locator('#input-new-food-calories').click();
  await expect(page.locator('#input-new-food-calories')).toHaveAttribute('nav-selected', 'true');
  await expect(page.locator('#input-new-food-name')).not.toHaveAttribute('nav-selected', 'true');

  // Enter must advance from Calories (Fat), not from Name (which would land
  // back on Serving Size — the bug this test guards against).
  await page.locator('#input-new-food-calories').fill('310');
  await page.locator('#input-new-food-calories').press('Enter');
  await expect(page.locator('#input-new-food-fat')).toHaveAttribute('nav-selected', 'true');
});

test('left softkey discards the form and returns to Search with its prior results intact', async ({ page }) => {
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  await page.fill('#input-new-food-name', 'should be discarded');
  await pressSoftKey(page, 'SoftLeft');

  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');
  await expect(page.locator('#input-search')).toHaveValue('apple');
  await expect(page.locator('.search-row', { hasText: 'Apple, Raw' })).toBeVisible();
});
