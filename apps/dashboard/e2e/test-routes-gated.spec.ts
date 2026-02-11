import { expect, test } from '@playwright/test';

test('renders not-found for /test when test routes are disabled', async ({ page }) => {
  await page.goto('/test');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
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
