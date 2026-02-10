import { defineConfig, devices } from '@playwright/test';

const DASHBOARD_PORT = 8080;

export default defineConfig({
  testDir: './apps/dashboard/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm --filter @alphred/dashboard build && pnpm --filter @alphred/dashboard start',
    url: `http://localhost:${DASHBOARD_PORT}`,
    timeout: 120000,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
