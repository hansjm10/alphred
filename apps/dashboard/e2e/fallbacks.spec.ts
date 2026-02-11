import { expect, test } from '@playwright/test';

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
