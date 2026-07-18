const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: true,
  webServer: {
    command: 'python3 -m http.server 8123',
    port: 8123,
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'ignore'
  },
  use: {
    baseURL: 'http://localhost:8123',
    viewport: { width: 240, height: 294 }
  }
});
