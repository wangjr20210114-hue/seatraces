import { defineConfig, devices } from "@playwright/test";
// This suite deliberately cannot target production via BASE_URL/TEST_URL.
export default defineConfig({
  testDir: "./e2e/specs",
  timeout: 90000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: "reports/ui/artifacts",
  reporter: [
    ["list"],
    ["html", { outputFolder: "reports/ui/html", open: "never" }],
    ["./e2e/reporter.mjs"],
  ],
  use: {
    baseURL: "http://127.0.0.1:19888",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    ...(process.env.UI_BROWSER ? { channel: process.env.UI_BROWSER } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    actionTimeout: 12000,
    navigationTimeout: 20000,
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.mjs/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" },
      testMatch: /mobile\.spec\.mjs/,
    },
  ],
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://127.0.0.1:19888/frontend-health",
    timeout: 1200000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
  globalTeardown: "./e2e/teardown.mjs",
});
