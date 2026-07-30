const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await mockDataHost(page);
});

async function goToLogin(page) {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pressSoftKey(page, 'SoftRight');
  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await page.locator('#opt-login').click();
  await expect(page.locator('#panel-login-email')).toHaveAttribute('active', 'true');
}

test('logged out shows a red (not green) header dot labeled "Logged Out"', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-diary .auth-dot')).not.toHaveClass(/auth-dot-on/);
  await expect(page.locator('#panel-diary .auth-status-text')).toHaveText('Logged Out');
});

test('OTP request -> verify -> csrf persisted -> dot turns green', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/account/otp', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'OTP sent' }) });
  });
  await page.route('https://api.calories.elliscode.com/account/login', function (route) {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Access-Control-Expose-Headers is required for xhr.getResponseHeader
      // to see a custom header cross-origin — same header the real backend
      // sets (see format_response in calorie_api/utils.py).
      headers: { 'x-csrf-token': 'abc123', 'Access-Control-Expose-Headers': 'x-csrf-token' },
      body: JSON.stringify({ message: 'ok' })
    });
  });
  await page.route('https://api.calories.elliscode.com/sync/**', function (route) { route.abort(); });

  await goToLogin(page);
  await page.fill('#input-login-email', 'test@example.com');
  await page.locator('#input-login-email').press('Enter');
  await expect(page.locator('#panel-login-otp')).toHaveAttribute('active', 'true');
  await expect(page.locator('#login-otp-hint')).toHaveText('Code sent to test@example.com');

  await page.fill('#input-login-otp', '123456');
  await page.locator('#input-login-otp').press('Enter');

  await expect(page.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-options .auth-dot')).toHaveClass(/auth-dot-on/);
  await expect(page.locator('#panel-options .auth-status-text')).toHaveText('Logged In');
  var csrf = await page.evaluate(function () { return localStorage.getItem('csrf'); });
  expect(csrf).toBe('abc123');
  var everLoggedIn = await page.evaluate(function () { return localStorage.getItem('everLoggedIn'); });
  expect(everLoggedIn).toBe('true');
});

test('wrong OTP shows an error and does not log in', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/account/otp', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'OTP sent' }) });
  });
  await page.route('https://api.calories.elliscode.com/account/login', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Incorrect OTP, please try again' }) });
  });

  await goToLogin(page);
  await page.fill('#input-login-email', 'test@example.com');
  await page.locator('#input-login-email').press('Enter');
  await expect(page.locator('#panel-login-otp')).toHaveAttribute('active', 'true');

  await page.fill('#input-login-otp', '000000');
  await page.locator('#input-login-otp').press('Enter');

  await expect(page.locator('.status-toast')).toHaveAttribute('visible', 'true');
  await expect(page.locator('#panel-login-otp')).toHaveAttribute('active', 'true');
  var csrf = await page.evaluate(function () { return localStorage.getItem('csrf'); });
  expect(csrf).toBeNull();
});

test('a rate-limit response shows a countdown and re-enables input after it elapses', async ({ page }) => {
  await page.route('https://api.calories.elliscode.com/account/otp', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'OTP sent' }) });
  });
  await page.route('https://api.calories.elliscode.com/account/login', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Please wait 2 seconds before trying again' }) });
  });

  await goToLogin(page);
  await page.fill('#input-login-email', 'test@example.com');
  await page.locator('#input-login-email').press('Enter');
  await page.fill('#input-login-otp', '000000');
  await page.locator('#input-login-otp').press('Enter');

  await expect(page.locator('#login-otp-hint')).toHaveText(/Try again in \d+s/);
  await expect(page.locator('#input-login-otp')).toBeDisabled();
  await expect(page.locator('#login-otp-hint')).toHaveText(/Code sent to/, { timeout: 4000 });
  await expect(page.locator('#input-login-otp')).toBeEnabled();
});

test('the privacy link opens an explanatory sheet', async ({ page }) => {
  await goToLogin(page);
  await page.locator('#btn-login-email-privacy').click();
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await expect(page.locator('#sheet-title')).toHaveText('What do we do with your email?');
  await expect(page.locator('#sheet-note')).toContainText('cryptographic hash');
});

test('logging out flips the dot back to red and clears csrf', async ({ page }) => {
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'existing-token');
    localStorage.setItem('everLoggedIn', 'true');
  });
  await page.route('https://api.calories.elliscode.com/sync/**', function (route) { route.abort(); });
  await page.goto('/');
  await expect(page.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await expect(page.locator('#panel-diary .auth-dot')).toHaveClass(/auth-dot-on/);

  await pressSoftKey(page, 'SoftRight');
  await page.locator('#opt-login').click();
  await expect(page.locator('#sheet')).toHaveAttribute('active', 'true');
  await page.locator('#sheet-ul .list-row').filter({ hasText: /^Log Out$/ }).click();

  await expect(page.locator('#panel-options .auth-dot')).not.toHaveClass(/auth-dot-on/);
  var csrf = await page.evaluate(function () { return localStorage.getItem('csrf'); });
  expect(csrf).toBeNull();
});
