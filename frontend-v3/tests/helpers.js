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

module.exports = { mockDataHost: mockDataHost, pressSoftKey: pressSoftKey };
