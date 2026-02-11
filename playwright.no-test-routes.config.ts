import { defineConfig, devices } from '@playwright/test';

// Use a non-dev port to avoid colliding with `pnpm dev:dashboard` (8080) and the main e2e suite.
const DASHBOARD_PORT = 18081;

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
    // Next build/start can be slow on cold caches or lower-powered machines.
    timeout: 300000,
    // Avoid silently pointing at an arbitrary already-running service on the same port.
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
