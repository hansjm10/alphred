import { expect, test } from '@playwright/test';

test('keeps /test disabled when build gate is off even if runtime env enables test routes', async ({ page }) => {
  const response = await page.goto('/test');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('keeps /test/slow disabled when build gate is off even if runtime env enables test routes', async ({ page }) => {
  const response = await page.goto('/test/slow');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('keeps /test/error disabled when build gate is off even if runtime env enables test routes', async ({ page }) => {
  const response = await page.goto('/test/error');

  expect(response).not.toBeNull();
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});
