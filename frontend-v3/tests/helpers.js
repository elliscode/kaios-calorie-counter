const path = require('path');

// `opts.afterAddFood` seeds the "After I add a food…" setting (app.js's
// getAfterAddFood/'afterAddFood' localStorage key) before the app boots, via
// addInitScript so it's in place before any of the app's own code runs.
// Defaults to 'direct' (today's instant-add behavior) since that's what
// every test written before that setting existed already assumes — pass
// `{ afterAddFood: null }` to skip seeding entirely and exercise the app's
// real default ('modify') instead, as after-add-food.spec.js does.
async function mockDataHost(page, opts) {
  opts = opts || {};
  var afterAddFood = 'afterAddFood' in opts ? opts.afterAddFood : 'direct';
  if (afterAddFood) {
    await page.addInitScript(function (mode) {
      localStorage.setItem('afterAddFood', mode);
    }, afterAddFood);
  }
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

// Diary -> Search is via the permanent "+ Add Food" button at ≤240px, or
// its >240px touchscreen-UI replacement, the Diary bottom nav's Add button
// (see css/bottom-nav.css) — both call the same showSearchPanel action.
// The `:visible` selector + Playwright's built-in auto-waiting picks
// whichever one the current viewport actually shows, without a one-shot
// isVisible() check racing the Diary panel's own show/hide transition.
async function goToSearchFromDiary(page) {
  await page.locator('#btn-diary-add-food:visible, #btn-bottom-nav-add:visible').click();
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
