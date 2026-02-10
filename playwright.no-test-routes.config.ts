import { defineConfig, devices } from '@playwright/test';

const DASHBOARD_PORT = 8081;

export default defineConfig({
  testDir: './apps/dashboard/e2e',
  testMatch: ['**/test-routes-gated.spec.ts'],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: './test-results/e2e-no-test-routes',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
  },
  webServer: {
    // For this suite, test-only dashboard routes must be disabled so we can assert gating behavior.
    command: `node ./apps/dashboard/scripts/e2e-webserver.mjs --port=${DASHBOARD_PORT} --test-routes=0`,
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
