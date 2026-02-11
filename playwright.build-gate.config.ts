import { defineConfig, devices } from '@playwright/test';

// Use a dedicated port to isolate this suite from other dashboard e2e runs.
const DASHBOARD_PORT = 18082;

export default defineConfig({
  testDir: './apps/dashboard/e2e',
  testMatch: ['**/test-routes-build-gate.spec.ts'],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: './test-results/e2e-build-gate',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
  },
  webServer: {
    // Build excludes /test/* routes; runtime flags should not be able to re-enable them.
    command: `node ./apps/dashboard/scripts/e2e-webserver.mjs --port=${DASHBOARD_PORT} --test-routes=1 --build-test-routes=0`,
    url: `http://localhost:${DASHBOARD_PORT}`,
    timeout: 300000,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
