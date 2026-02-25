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

test('cancels an in-progress run from run detail controls', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await page.goto(`/runs/${fixtures.runningRunId}`);
  await expect(page.getByRole('heading', { name: `Run #${fixtures.runningRunId}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Run', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Cancel Run', exact: true }).click();

  await expect(page.getByText('Run cancelled.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Cancelled' })).toBeDisabled();

  const detailResponse = await page.request.get(`/api/dashboard/runs/${fixtures.runningRunId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as {
    run?: {
      status?: string;
    };
  };
  expect(detail.run?.status).toBe('cancelled');
});

test('supports pause then resume lifecycle controls from run detail', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await page.goto(`/runs/${fixtures.runningRunId}`);
  await expect(page.getByRole('heading', { name: `Run #${fixtures.runningRunId}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText('Run paused.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  const pausedDetailResponse = await page.request.get(`/api/dashboard/runs/${fixtures.runningRunId}`);
  expect(pausedDetailResponse.ok()).toBeTruthy();
  const pausedDetail = (await pausedDetailResponse.json()) as {
    run?: {
      status?: string;
    };
  };
  expect(pausedDetail.run?.status).toBe('paused');

  await page.goto(`/runs/${fixtures.pausedRunId}`);
  await expect(page.getByRole('heading', { name: `Run #${fixtures.pausedRunId}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByText('Run resumed.')).toBeVisible();

  const resumedDetailResponse = await page.request.get(`/api/dashboard/runs/${fixtures.pausedRunId}`);
  expect(resumedDetailResponse.ok()).toBeTruthy();
  const resumedDetail = (await resumedDetailResponse.json()) as {
    run?: {
      status?: string;
    };
  };
  expect(['running', 'completed']).toContain(resumedDetail.run?.status);
});

test('retries a failed run from run detail and preserves prior attempt telemetry', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await page.goto(`/runs/${fixtures.failedRunId}`);
  await expect(page.getByRole('heading', { name: `Run #${fixtures.failedRunId}` })).toBeVisible();
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

  const detailResponse = await page.request.get(`/api/dashboard/runs/${fixtures.failedRunId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as {
    nodes?: {
      id: number;
      attempt: number;
    }[];
    diagnostics?: {
      runNodeId: number;
      attempt: number;
    }[];
  };

  const retriedNode = detail.nodes?.find(node => node.id === fixtures.failedRunNodeId) ?? null;
  expect(retriedNode).not.toBeNull();
  expect(retriedNode?.attempt ?? 0).toBeGreaterThanOrEqual(2);

  const retainedAttemptOneDiagnostics =
    detail.diagnostics?.some(
      diagnostic => diagnostic.runNodeId === fixtures.failedRunNodeId && diagnostic.attempt === 1,
    ) ?? false;
  expect(retainedAttemptOneDiagnostics).toBe(true);
});
