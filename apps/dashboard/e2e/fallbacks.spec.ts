import { expect, test } from '@playwright/test';

test('renders loading and not-found fallbacks under navigation', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'Open slow dashboard route' }).click();
  await expect(page.getByRole('heading', { name: 'Loading dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Slow dashboard page' })).toBeVisible();

  await page.goto('/definitely-missing-route');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});
