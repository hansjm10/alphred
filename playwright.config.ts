import { defineConfig, devices } from '@playwright/test';

const DASHBOARD_PORT = 8080;

export default defineConfig({
  testDir: './apps/dashboard/e2e',
  fullyParallel: false,
  // Keep local runs fast, but enable retries in CI so `trace: on-first-retry` can actually capture traces.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
  },
  webServer: {
    // Test-only dashboard routes are gated; enable them for e2e runs only.
    command:
      'ALPHRED_DASHBOARD_TEST_ROUTES=1 pnpm --filter @alphred/dashboard build && ALPHRED_DASHBOARD_TEST_ROUTES=1 pnpm --filter @alphred/dashboard start',
    url: `http://localhost:${DASHBOARD_PORT}`,
    timeout: 120000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
