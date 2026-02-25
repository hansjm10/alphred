import { expect, test, type Page } from '@playwright/test';

type LifecycleFixturePayload = {
  runningRunId: number;
  pausedRunId: number;
  failedRunId: number;
  failedRunNodeId: number;
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function seedLifecycleFixtures(page: Page): Promise<LifecycleFixturePayload> {
  const response = await page.request.post('/test/lifecycle-fixtures');
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as Partial<LifecycleFixturePayload>;

  expect(isPositiveInteger(payload.runningRunId)).toBe(true);
  expect(isPositiveInteger(payload.pausedRunId)).toBe(true);
  expect(isPositiveInteger(payload.failedRunId)).toBe(true);
  expect(isPositiveInteger(payload.failedRunNodeId)).toBe(true);

  if (
    !isPositiveInteger(payload.runningRunId) ||
    !isPositiveInteger(payload.pausedRunId) ||
    !isPositiveInteger(payload.failedRunId) ||
    !isPositiveInteger(payload.failedRunNodeId)
  ) {
    throw new Error('Expected /test/lifecycle-fixtures to return numeric run fixture ids.');
  }

  return {
    runningRunId: payload.runningRunId,
    pausedRunId: payload.pausedRunId,
    failedRunId: payload.failedRunId,
    failedRunNodeId: payload.failedRunNodeId,
  };
}

async function openRunDetail(page: Page, runId: number): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('heading', { name: `Run #${runId}` })).toBeVisible();
}

async function getRunDetail<T>(page: Page, runId: number): Promise<T> {
  const response = await page.request.get(`/api/dashboard/runs/${runId}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as T;
}

test('cancels an in-progress run from run detail controls', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.runningRunId);
  await expect(page.getByRole('button', { name: 'Cancel Run', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Cancel Run', exact: true }).click();

  await expect(page.getByText('Run cancelled.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Cancelled' })).toBeDisabled();

  const detail = await getRunDetail<{
    run?: {
      status?: string;
    };
  }>(page, fixtures.runningRunId);
  expect(detail.run?.status).toBe('cancelled');
});

test('supports pause then resume lifecycle controls from run detail', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.runningRunId);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Run paused.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  const pausedDetail = await getRunDetail<{
    run?: {
      status?: string;
    };
  }>(page, fixtures.runningRunId);
  expect(pausedDetail.run?.status).toBe('paused');

  await openRunDetail(page, fixtures.pausedRunId);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByText('Run resumed.')).toBeVisible();

  const resumedDetail = await getRunDetail<{
    run?: {
      status?: string;
    };
  }>(page, fixtures.pausedRunId);
  expect(['running', 'completed']).toContain(resumedDetail.run?.status);
});

test('retries a failed run from run detail and preserves prior attempt telemetry', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.failedRunId);
  await expect(page.getByRole('button', { name: 'Retry Failed Node', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Retry Failed Node', exact: true }).click();
  await expect(page.getByText(/Retry queued for/)).toBeVisible();

  const streamSnapshotResponse = await page.request.get(
    `/api/dashboard/runs/${fixtures.failedRunId}/nodes/${fixtures.failedRunNodeId}/stream?attempt=1`,
  );
  expect(streamSnapshotResponse.ok()).toBeTruthy();
  const streamSnapshot = (await streamSnapshotResponse.json()) as {
    attempt?: number;
    ended?: boolean;
    events?: { sequence: number }[];
  };
  expect(streamSnapshot.attempt).toBe(1);
  expect(streamSnapshot.ended).toBe(true);
  expect(Array.isArray(streamSnapshot.events)).toBe(true);
  expect(streamSnapshot.events?.length ?? 0).toBeGreaterThan(0);

  const detail = await getRunDetail<{
    nodes?: {
      id: number;
      attempt: number;
    }[];
    diagnostics?: {
      runNodeId: number;
      attempt: number;
    }[];
  }>(page, fixtures.failedRunId);

  const retriedNode = detail.nodes?.find(node => node.id === fixtures.failedRunNodeId) ?? null;
  expect(retriedNode).not.toBeNull();
  expect(retriedNode?.attempt ?? 0).toBeGreaterThanOrEqual(2);

  const retainedAttemptOneDiagnostics =
    detail.diagnostics?.some(
      diagnostic => diagnostic.runNodeId === fixtures.failedRunNodeId && diagnostic.attempt === 1,
    ) ?? false;
  expect(retainedAttemptOneDiagnostics).toBe(true);
});

test('supports section jump navigation across desktop and mobile while preserving skip-link behavior', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.runningRunId);

  const sectionNav = page.getByRole('navigation', { name: 'Run detail sections' });
  await expect(sectionNav).toBeVisible();

  const expectedSections = [
    { label: 'Focus', id: 'run-section-focus' },
    { label: 'Timeline', id: 'run-section-timeline' },
    { label: 'Stream', id: 'run-section-stream' },
    { label: 'Observability', id: 'run-section-observability' },
  ] as const;

  for (const section of expectedSections) {
    await expect(sectionNav.getByRole('link', { name: section.label })).toHaveAttribute('href', `#${section.id}`);
    await expect(page.locator(`#${section.id}`)).toBeVisible();
  }

  await sectionNav.getByRole('link', { name: 'Observability' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${fixtures.runningRunId}#run-section-observability$`));
  await expect(sectionNav.getByRole('link', { name: 'Observability' })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#run-section-observability').getByRole('heading', { name: 'Observability' })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await openRunDetail(page, fixtures.runningRunId);

  const mobileSectionNav = page.getByRole('navigation', { name: 'Run detail sections' });
  await expect(mobileSectionNav).toBeVisible();
  const navMetrics = await mobileSectionNav.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(navMetrics.scrollWidth).toBeGreaterThanOrEqual(navMetrics.clientWidth);

  await mobileSectionNav.getByRole('link', { name: 'Stream' }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${fixtures.runningRunId}#run-section-stream$`));
  await expect(mobileSectionNav.getByRole('link', { name: 'Stream' })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#run-section-stream').getByRole('heading', { name: 'Agent stream' })).toBeVisible();

  await page.goto(`/runs/${fixtures.runningRunId}`);
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/runs/${fixtures.runningRunId}#main-content$`));
});
