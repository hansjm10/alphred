import { expect, test, type Response } from '@playwright/test';

async function expectProxyHardNotFound(responsePromise: Promise<Response | null>) {
  const response = await responsePromise;
  expect(response).not.toBeNull();
  if (!response) {
    throw new Error('Expected a response for gated test route.');
  }

  expect(response.status()).toBe(404);
  expect(response.headers()['x-robots-tag']).toBe('noindex');
  expect(response.headers()['content-type']).toContain('text/html');

  const body = await response.text();
  expect(body).toContain('<meta name="robots" content="noindex" />');
  expect(body).toContain('<title>Page not found</title>');
}

test('renders not-found for /test when test routes are disabled', async ({ page }) => {
  await expectProxyHardNotFound(page.goto('/test'));
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders not-found for /test/slow when test routes are disabled', async ({ page }) => {
  await expectProxyHardNotFound(page.goto('/test/slow'));
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});

test('renders not-found for /test/error when test routes are disabled', async ({ page }) => {
  await expectProxyHardNotFound(page.goto('/test/error'));
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to home' })).toHaveAttribute('href', '/');
});
