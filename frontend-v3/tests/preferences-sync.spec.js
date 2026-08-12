const { test, expect } = require('@playwright/test');
const { mockDataHost, pressSoftKey } = require('./helpers');

// Verifies the actual cross-browser round trip for settings (e.g. "Enable
// Meals"): two independent browser contexts, both "logged in" (faked via
// localStorage csrf/everLoggedIn — same technique tests/my-foods.spec.js
// already uses), pushing/pulling against ONE shared fake server-side
// preferences store. This mirrors backend/lambda/calorie_api/sync.py's own
// sync_preferences_route + merge_dict logic (whole `settings` blob,
// newer-`updated`-wins) rather than hand-crafting a fixture response, so
// it's a faithful simulation of what actually happens between two real
// browsers signed into the same account.
function makeFakeServer() {
  var stored = {}; // { settings: {...}, lastServings: {}, usageCounts: {} }
  return {
    install: function (page) {
      return page.route('https://api.calories.elliscode.com/sync/preferences', function (route) {
        var body = route.request().postDataJSON();
        if (body.settings) {
          var clientUpdated = body.settings.updated || 0;
          var serverUpdated = (stored.settings && stored.settings.updated) || 0;
          if (!stored.settings || clientUpdated > serverUpdated) {
            stored.settings = body.settings;
          }
        }
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            settings: stored.settings || {},
            lastServings: stored.lastServings || {},
            usageCounts: stored.usageCounts || {}
          })
        });
      });
    }
  };
}

async function fakeLogin(page) {
  await page.addInitScript(function () {
    localStorage.setItem('csrf', 'test-csrf');
    localStorage.setItem('everLoggedIn', 'true');
  });
}

test('toggling "Enable Meals" while logged in propagates to a second, already-logged-in browser on its next boot', async ({ browser }) => {
  var server = makeFakeServer();

  var contextA = await browser.newContext();
  var pageA = await contextA.newPage();
  await fakeLogin(pageA);
  await mockDataHost(pageA);
  await server.install(pageA);
  await pageA.goto('/');
  await expect(pageA.locator('#panel-diary')).toHaveAttribute('active', 'true');

  // Session A: turn Meals on. The click's own syncPreferences() call is
  // what actually pushes it — wait for that exact response, not just the
  // UI toggling (which happens instantly, locally, before any network
  // round trip).
  await pressSoftKey(pageA, 'SoftRight');
  await expect(pageA.locator('#panel-options')).toHaveAttribute('active', 'true');
  var pushResponse = pageA.waitForResponse('https://api.calories.elliscode.com/sync/preferences');
  await pageA.locator('#opt-meals-enabled').click();
  await expect(pageA.locator('#opt-meals-enabled-value')).toHaveText('On');
  await pushResponse;

  // Session B: a separate browser context — different localStorage/
  // IndexedDB entirely, simulating a different browser/device — also
  // logged in (same account, from the fake server's point of view).
  var contextB = await browser.newContext();
  var pageB = await contextB.newPage();
  await fakeLogin(pageB);
  await mockDataHost(pageB);
  await server.install(pageB);
  // Boot-time runFullSync() (app.js) is what pulls this down — it's async
  // and fires *after* showDiaryPanel() already made #panel-diary active,
  // so wait for its actual /sync/preferences response, not just the panel
  // becoming active, before checking Options.
  var pullResponse = pageB.waitForResponse('https://api.calories.elliscode.com/sync/preferences');
  await pageB.goto('/');
  await expect(pageB.locator('#panel-diary')).toHaveAttribute('active', 'true');
  await pullResponse;

  await pressSoftKey(pageB, 'SoftRight');
  await expect(pageB.locator('#panel-options')).toHaveAttribute('active', 'true');
  await expect(pageB.locator('#opt-meals-enabled-value')).toHaveText('On');

  await contextA.close();
  await contextB.close();
});
