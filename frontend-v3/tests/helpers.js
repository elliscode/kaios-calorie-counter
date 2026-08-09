const path = require('path');

async function mockDataHost(page) {
  await page.route('https://calories.elliscode.com/manifest.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/manifest.json') });
  });
  await page.route('https://calories.elliscode.com/sample-foods.json', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/sample-foods.json') });
  });
}

// KaiOS softkeys ('SoftLeft'/'SoftRight') aren't real browser keys Playwright
// can synthesize via keyboard.press, so dispatch them directly against the
// same document-level 'keydown' listener the app registers.
async function pressSoftKey(page, key) {
  await page.evaluate(function (k) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  }, key);
}

// Diary -> Search is now via the permanent "+ Add Food" button (no more
// Search left-softkey on Diary), not a pressSoftKey call.
async function goToSearchFromDiary(page) {
  await page.locator('#btn-diary-add-food').click();
}

// Replaces the vendored ZXing build with tests/fixtures/fake-zxing.js so
// scan tests never touch real camera hardware — see that file for what it
// exposes. Must be called before page.goto('/'), same as mockDataHost.
async function mockZxing(page) {
  await page.route('**/js/vendor/zxing.min.js', function (route) {
    route.fulfill({ path: path.join(__dirname, 'fixtures/fake-zxing.js'), contentType: 'application/javascript' });
  });
}

// Clicks the scan button, waits for showScanPanel() to have actually started
// a "scan" (i.e. fake-zxing.js's decodeFromConstraints has run and installed
// its hook), then simulates a successful decode of `upc`. `format` is a
// ZXing.BarcodeFormat key (e.g. 'UPC_E', 'EAN_13') — omit for the default
// (UPC_A), which is all most tests care about.
async function scanBarcode(page, upc, format) {
  await page.locator('#btn-scan-upc').click();
  await page.waitForFunction(function () { return typeof window.__zxingEmit === 'function'; });
  await page.evaluate(function (args) {
    var fmt = args.format ? window.ZXing.BarcodeFormat[args.format] : undefined;
    window.__zxingEmit(args.code, fmt);
  }, { code: upc, format: format });
}

module.exports = {
  mockDataHost: mockDataHost,
  pressSoftKey: pressSoftKey,
  goToSearchFromDiary: goToSearchFromDiary,
  mockZxing: mockZxing,
  scanBarcode: scanBarcode
};
