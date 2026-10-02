import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real editor (dist/web) served by `cutroom open` against
// temp projects made from test/fixtures/talking.mp4. Run `npm run build` first.
export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium" }],
});
