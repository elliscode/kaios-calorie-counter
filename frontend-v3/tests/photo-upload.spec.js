const { test, expect } = require('@playwright/test');
const { mockDataHost, goToSearchFromDiary } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
});

test('a photo goes through presigned-post -> direct S3 upload -> /submit with photoKey, in that order', async ({ page }) => {
  var calls = [];

  await page.route('https://api.calories.elliscode.com/presigned-post', async function (route) {
    var body = route.request().postDataJSON();
    calls.push({ step: 'presigned-post', body: body });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        url: 'https://fake-bucket.s3.amazonaws.com/',
        fields: { key: body.id + '.' + body.extension, 'Content-Type': 'image/jpeg' }
      })
    });
  });

  await page.route('https://fake-bucket.s3.amazonaws.com/**', async function (route) {
    calls.push({ step: 's3-upload' });
    await route.fulfill({ status: 204, body: '' });
  });

  await page.route('https://api.calories.elliscode.com/submit', async function (route) {
    var body = route.request().postDataJSON();
    calls.push({ step: 'submit', body: body });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.id }) });
  });

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'granola bar');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();

  await expect(page.locator('#panel-new-food')).toHaveAttribute('active', 'true');
  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'bar');
  await page.fill('#input-new-food-calories', '180');
  await page.setInputFiles('#input-new-food-photo', {
    name: 'label.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  });

  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Give the background chain a moment to finish (it's not awaited by the UI).
  await expect.poll(function () { return calls.length; }, { timeout: 3000 }).toBe(3);

  expect(calls.map(function (c) { return c.step; })).toEqual(['presigned-post', 's3-upload', 'submit']);
  expect(calls[0].body.extension).toBe('jpg');
  expect(calls[2].body.photoKey).toBe(calls[0].body.id + '.jpg');
  expect(calls[2].body.id).toBe(calls[0].body.id);
});

test('a food with no photo skips straight to /submit with no photoKey', async ({ page }) => {
  var calls = [];
  await page.route('https://api.calories.elliscode.com/presigned-post', async function (route) {
    calls.push('presigned-post');
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.route('https://api.calories.elliscode.com/submit', async function (route) {
    var body = route.request().postDataJSON();
    calls.push('submit');
    expect(body.photoKey).toBeUndefined();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: body.id }) });
  });

  await goToSearchFromDiary(page);
  await page.fill('#input-search', 'plain snack');
  await page.waitForTimeout(250);
  await page.locator('#panel-search .search-row.add-new').click();
  await page.fill('#input-new-food-serving-qty', '1');
  await page.fill('#input-new-food-serving-name', 'serving');
  await page.fill('#input-new-food-calories', '100');
  await page.locator('#btn-new-food-submit').click();
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');

  await expect.poll(function () { return calls.length; }, { timeout: 3000 }).toBe(1);
  expect(calls).toEqual(['submit']); // presigned-post never called when there's no photo
});
