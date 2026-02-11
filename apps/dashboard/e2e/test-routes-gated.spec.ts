import { expect, test } from '@playwright/test';

test('renders not-found for /test when test routes are disabled', async ({ page }) => {
  const response = await page.goto('/test');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders not-found for /test/slow when test routes are disabled', async ({ page }) => {
  const response = await page.goto('/test/slow');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders not-found for /test/error when test routes are disabled', async ({ page }) => {
  const response = await page.goto('/test/error');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});
