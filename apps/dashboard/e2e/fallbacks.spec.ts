import { expect, test } from '@playwright/test';

test('serves favicon without 404', async ({ page }) => {
  const response = await page.request.get('/favicon.ico');
  expect(response.ok()).toBeTruthy();
});

test('renders loading and not-found fallbacks under navigation', async ({ page }) => {
  await page.goto('/test');

  await page.getByRole('link', { name: 'Open slow dashboard route' }).click();
  await expect(page.getByRole('heading', { name: 'Loading dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Slow dashboard page' })).toBeVisible();

  await page.goto('/definitely-missing-route');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders the error boundary fallback when a route throws', async ({ page }) => {
  await page.goto('/test/error');

  await expect(page.getByRole('heading', { name: 'Dashboard error' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard error' })).toBeVisible();
});

test('keeps repositories and runs usable on mobile without document-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  for (const [route, headingName] of [
    ['/repositories', 'Repository registry'],
    ['/runs', 'Run lifecycle'],
  ] as const) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: headingName })).toBeVisible();

    const metrics = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    const maxAllowedScrollWidth = metrics.innerWidth + 1;

    expect(metrics.docScrollWidth).toBeLessThanOrEqual(maxAllowedScrollWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(maxAllowedScrollWidth);
  }
});
