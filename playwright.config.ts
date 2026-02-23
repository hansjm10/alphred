import { defineConfig, devices } from '@playwright/test';

// Use a non-dev port to avoid colliding with `pnpm dev:dashboard` (8080).
const DASHBOARD_PORT = 18080;

export default defineConfig({
  testDir: './apps/dashboard/e2e',
  testMatch: ['**/fallbacks.spec.ts', '**/worktree-explorer.spec.ts', '**/workflow-builder.spec.ts'],
  fullyParallel: false,
  // Keep local runs fast, but enable retries in CI so `trace: on-first-retry` can actually capture traces.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: './test-results/e2e-test-routes',
  use: {
    baseURL: `http://localhost:${DASHBOARD_PORT}`,
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
  },
  webServer: {
    // Test-only dashboard routes are gated; enable them for e2e runs only.
    command: `node --no-warnings ./apps/dashboard/scripts/e2e-webserver.mjs --port=${DASHBOARD_PORT} --test-routes=1 --build-test-routes=1`,
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
