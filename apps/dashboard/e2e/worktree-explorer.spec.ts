import { expect, test, type Page } from '@playwright/test';

type CreateWorkflowResponse = {
  workflow?: {
    treeKey?: string;
    draftVersion?: number;
  };
};

async function createPublishedWorkflowTree(page: Page): Promise<string> {
  const treeKey = `worktree-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createResponse = await page.request.post('/api/dashboard/workflows', {
    data: {
      template: 'design-implement-review',
      name: 'Worktree E2E Fixture',
      treeKey,
      description: 'Created by Playwright e2e for persisted run coverage.',
    },
  });
  expect(createResponse.status()).toBe(201);
  const createPayload = await createResponse.json() as CreateWorkflowResponse;
  expect(createPayload.workflow?.treeKey).toBe(treeKey);
  const draftVersion = createPayload.workflow?.draftVersion;
  expect(typeof draftVersion).toBe('number');
  if (typeof draftVersion !== 'number') {
    throw new Error('Expected workflow creation response to include draftVersion.');
  }

  const publishResponse = await page.request.post(
    `/api/dashboard/workflows/${encodeURIComponent(treeKey)}/draft/publish?version=${draftVersion}`,
    {
      data: {},
    },
  );
  expect(publishResponse.status()).toBe(200);

  return treeKey;
}

async function createPersistedRunWithoutWorktree(page: Page): Promise<number> {
  const treeKey = await createPublishedWorkflowTree(page);

  const launchResponse = await page.request.post('/api/dashboard/runs', {
    data: {
      treeKey,
      executionMode: 'async',
    },
  });
  expect(launchResponse.status()).toBe(202);

  const launchPayload = await launchResponse.json() as { workflowRunId?: number };
  const workflowRunId = launchPayload.workflowRunId;
  expect(typeof workflowRunId).toBe('number');
  if (typeof workflowRunId !== 'number') {
    throw new Error('Expected /api/dashboard/runs to return workflowRunId.');
  }

  return workflowRunId;
}

test('supports desktop worktree navigation and preview mode toggles', async ({ page }) => {
  await page.goto('/runs/412/worktree');

  await expect(page.getByRole('heading', { name: 'Run #412 worktree' })).toBeVisible();
  const changedBadge = page.getByLabel('src/core/engine.ts changed');
  await expect(changedBadge).toBeVisible();
  const changedBadgeStyles = await changedBadge.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      borderTopLeftRadius: styles.borderTopLeftRadius,
      backgroundColor: styles.backgroundColor,
    };
  });
  expect(changedBadgeStyles.borderTopLeftRadius).toBe('999px');
  expect(changedBadgeStyles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');

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

test('renders persisted-run worktree route for newly launched runs without worktree metadata', async ({ page }) => {
  const runId = await createPersistedRunWithoutWorktree(page);

  await page.goto(`/runs/${runId}/worktree`);

  await expect(page.getByRole('heading', { name: `Run #${runId} worktree` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No changed files' })).toBeVisible();
  await expect(page.getByText('This run does not have a captured worktree.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', `/runs/${runId}`);
});
