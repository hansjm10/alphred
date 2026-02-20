import { expect, test } from '@playwright/test';

test('supports desktop worktree navigation and preview mode toggles', async ({ page }) => {
  await page.goto('/runs/412/worktree');

  await expect(page.getByRole('heading', { name: 'Run #412 worktree' })).toBeVisible();
  await expect(page.getByLabel('src/core/engine.ts changed')).toBeVisible();

  await page.getByRole('link', { name: 'Open README.md preview' }).click();
  await expect(page).toHaveURL(/path=README\.md/);

  await page.getByRole('link', { name: 'View Content' }).click();
  await expect(page).toHaveURL(/view=content/);
  await expect(page.getByLabel('File content preview')).toBeVisible();

  await page.getByRole('link', { name: 'View Diff' }).click();
  await expect(page).toHaveURL(/view=diff/);
  await expect(page.getByLabel('File diff preview')).toBeVisible();
});

test('stacks worktree columns on mobile and preserves deep-link behavior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/runs/410/worktree?path=does/not/exist.md');

  await expect(page.getByRole('heading', { name: 'Run #410 worktree' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open reports/final-summary.md preview' })).toBeVisible();

  const leftCard = page.locator('.worktree-grid .surface-card').first();
  const rightPanel = page.locator('.worktree-grid .surface-panel').first();
  const leftBox = await leftCard.boundingBox();
  const rightBox = await rightPanel.boundingBox();

  expect(leftBox).not.toBeNull();
  expect(rightBox).not.toBeNull();
  if (!leftBox || !rightBox) {
    throw new Error('Expected worktree grid columns to render on mobile.');
  }

  expect(rightBox.y).toBeGreaterThan(leftBox.y);

  await page.getByRole('link', { name: 'View Content' }).click();
  await expect(page).toHaveURL(/path=reports%2Ffinal-summary\.md&view=content/);
  await expect(page.getByLabel('File content preview')).toBeVisible();
});
