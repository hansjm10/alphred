import { expect, test } from '@playwright/test';

test('does not show the test route link on the home page when test routes are disabled', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('link', { name: 'Open slow dashboard route' })).toHaveCount(0);
});

test('renders not-found for /test/slow when test routes are disabled', async ({ page }) => {
  await page.goto('/test/slow');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders not-found for /test/error when test routes are disabled', async ({ page }) => {
  await page.goto('/test/error');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

