const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey, goToSearchFromDiary } = require('./helpers');

async function quickAddMilk(page) {
  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'milk');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Milk, Whole' }).click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
}

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('a food with no history defaults to its base "g" serving', async ({ page }) => {
  await quickAddMilk(page);
  await expect(page.locator('.food-row-serving')).toHaveText('100 g');
});

test('editing a serving is remembered as the default for that food next time', async ({ page }) => {
  await quickAddMilk(page);
  await page.locator('.food-row').click();
  await expect(page.locator('#panel-servings')).toHaveAttribute('active', 'true');

  await page.selectOption('#input-serving-name', 'fl oz');
  await page.fill('#input-serving-qty', '8');
  await page.keyboard.press('Enter'); // saveServingsEdit()
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('.food-row-serving')).toHaveText('8 fl oz');

  // Remove this entry entirely — the remembered default should survive
  // independently of any diary entry actually existing right now.
  await page.locator('.food-row').click();
  await pressSoftKey(page, 'SoftRight'); // delete
  await expect(page.locator('#diary-empty')).toBeVisible();

  // Adding the same food again should default to the remembered serving,
  // not fall back to the food's base "g" serving.
  await quickAddMilk(page);
  await expect(page.locator('.food-row-serving')).toHaveText('8 fl oz');
});

test('remembered serving is per-food, not global', async ({ page }) => {
  await quickAddMilk(page);
  await page.locator('.food-row').click();
  await page.selectOption('#input-serving-name', 'cup');
  await page.fill('#input-serving-qty', '2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.food-row-serving')).toHaveText('2 cup');

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'apple');
  await page.waitForTimeout(250);
  await page.locator('.search-row', { hasText: 'Apple, Raw' }).click();

  // Apple has no history of its own — should still use its base "g" serving,
  // unaffected by Milk's remembered "2 cup".
  await expect(page.locator('.food-row', { hasText: 'Apple, Raw' }).locator('.food-row-serving')).toHaveText('100 g');
});
