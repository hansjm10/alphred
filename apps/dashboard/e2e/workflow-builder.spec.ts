import { expect, test } from '@playwright/test';

test('validates tree-key format inline on workflow creation', async ({ page }) => {
  await page.goto('/workflows/new');

  await page.getByRole('textbox', { name: 'Name' }).fill('Inline Validation Demo');
  const treeKeyInput = page.getByRole('textbox', { name: /^Tree key/ });

  await treeKeyInput.fill('Bad Key');
  await expect(page.getByRole('alert').first()).toHaveText(
    'Tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
  );
  await expect(page.getByRole('button', { name: 'Create and open builder' })).toBeDisabled();

  const uniqueTreeKey = `workflow-e2e-${Date.now()}`;
  await treeKeyInput.fill(uniqueTreeKey);
  await expect(page.getByText('Tree key is available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create and open builder' })).toBeEnabled();
});

test('supports palette search and mobile inspector drawer behavior in the editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workflows/test/edit');

  const palette = page.getByRole('complementary', { name: 'Node palette' });
  const paletteSearch = page.getByRole('searchbox', { name: 'Search node templates' });
  await expect(paletteSearch).toBeVisible();

  await paletteSearch.fill('tool');
  await expect(palette.getByRole('button', { name: /Tool node/i })).toBeVisible();
  await expect(palette.getByRole('button', { name: /Agent node Provider-backed phase with prompt template support/i })).toHaveCount(0);

  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await expect(inspector).not.toHaveClass(/workflow-editor-inspector--open/);
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(inspector).toHaveClass(/workflow-editor-inspector--open/);
  await expect(page.locator('.workflow-editor-inspector-backdrop')).toBeVisible();

  await page.locator('.workflow-editor-inspector-backdrop').click();
  await expect(inspector).not.toHaveClass(/workflow-editor-inspector--open/);
});
