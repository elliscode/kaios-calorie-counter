const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.route('https://api.calories.elliscode.com/submit', function (route) {
    route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'protein muffin');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');

  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'muffin');
  await page.fill('#input-new-food-calories', '310');
});

test('a fully-filled extra serving is included and selectable afterward', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(1);

  await page.fill('#extra-serving-0-serving-qty', '100');
  await page.fill('#extra-serving-0-serving-name', 'g');
  await page.fill('#extra-serving-0-calories', '250');
  await page.fill('#extra-serving-0-fat', '8');
  await page.fill('#extra-serving-0-carbs', '35');
  await page.fill('#extra-serving-0-protein', '15');

  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');
  var options = await page.locator('#input-serving-name option').allTextContents();
  expect(options).toEqual(['muffin', 'g']);
});

test('an untouched extra-serving block is silently skipped, not required', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(1);

  // Leave every field in the extra block blank.
  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await page.locator('.food-row').click();
  var options = await page.locator('#input-serving-name option').allTextContents();
  expect(options).toEqual(['muffin']);
});

test('a partially-filled extra serving blocks submission with an error', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  // Only quantity filled in — name/calories left blank.
  await page.fill('#extra-serving-0-serving-qty', '100');

  await page.locator('#btn-new-food-submit').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');
});

test('multiple extra servings can be added, each independently addressable', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(2);

  await page.fill('#extra-serving-0-serving-qty', '100');
  await page.fill('#extra-serving-0-serving-name', 'g');
  await page.fill('#extra-serving-0-calories', '250');

  await page.fill('#extra-serving-1-serving-qty', '2');
  await page.fill('#extra-serving-1-serving-name', 'muffins');
  await page.fill('#extra-serving-1-calories', '620');

  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('.food-row').click();
  var options = await page.locator('#input-serving-name option').allTextContents();
  expect(options).toEqual(['muffin', 'g', 'muffins']);
});

test('clicking "Add additional serving" focuses the new block\'s first field', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('#extra-serving-0-serving-qty')).toHaveAttribute('nav-selected', 'true');
});

test('Remove deletes a single extra-serving block, leaving the others intact', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(2);

  await page.fill('#extra-serving-0-serving-qty', '100');
  await page.fill('#extra-serving-0-serving-name', 'g');
  await page.fill('#extra-serving-1-serving-qty', '2');
  await page.fill('#extra-serving-1-serving-name', 'muffins');

  // Remove the first block -- the second's fields (and its own Remove
  // button) survive, addressed by their own original ids.
  await page.locator('.extra-serving-block').nth(0).locator('.remove-serving-btn').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(1);
  await expect(page.locator('#extra-serving-1-serving-name')).toHaveValue('muffins');

  // Focus lands somewhere sane (the Add button), not on a now-detached node.
  await expect(page.locator('#btn-add-extra-serving')).toHaveAttribute('nav-selected', 'true');

  await page.fill('#extra-serving-1-calories', '620');
  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await page.locator('.food-row').click();
  var options = await page.locator('#input-serving-name option').allTextContents();
  expect(options).toEqual(['muffin', 'muffins']); // the "g" block is gone
});

test('Remove is reached after all of a block\'s fields, not before them', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  var selectableIds = await page.$$eval(
    '#extra-servings-container [nav-selectable="true"]',
    els => els.map(el => el.id || el.className)
  );
  expect(selectableIds[selectableIds.length - 1]).toBe('remove-serving-btn');
});

test('reopening the New Food panel clears any leftover extra-serving blocks', async ({ page }) => {
  await page.locator('#btn-add-extra-serving').click();
  await expect(page.locator('.extra-serving-block')).toHaveCount(1);

  await pressSoftKey(page, 'SoftLeft'); // discard -> back to Search
  await expect(page.locator('#panel-search')).toHaveAttribute('active', 'true');

  await page.fill('#input-search', 'zzznonexistent');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await expect(page.locator('.extra-serving-block')).toHaveCount(0);
});
