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
    !isPositiveInteger(payload.runningRunId)
    || !isPositiveInteger(payload.pausedRunId)
    || !isPositiveInteger(payload.failedRunId)
    || !isPositiveInteger(payload.failedRunNodeId)
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

async function jumpToSection(page: Page, runId: number, sectionLabel: string, headingId: string): Promise<void> {
  const sectionNav = page.getByRole('navigation', { name: 'Run detail sections' });
  const sectionLink = sectionNav.getByRole('link', { name: sectionLabel, exact: true });

  await sectionLink.click();

  await expect(page).toHaveURL(new RegExp(`/runs/${runId}#${headingId}$`));
  await expect(page.locator(`#${headingId}`)).toBeVisible();
  await expect(page.locator(`#${headingId}`)).toBeInViewport();
  await expect(sectionLink).toHaveAttribute('aria-current', 'location');
}

test('desktop jump nav updates hash and brings section targets into view', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.runningRunId);

  const sectionNav = page.getByRole('navigation', { name: 'Run detail sections' });
  const focusLink = sectionNav.getByRole('link', { name: 'Focus', exact: true });
  const timelineLink = sectionNav.getByRole('link', { name: 'Timeline', exact: true });

  await expect(sectionNav).toBeVisible();
  await expect(focusLink).toHaveAttribute('aria-current', 'location');

  await jumpToSection(page, fixtures.runningRunId, 'Timeline', 'run-detail-timeline-heading');
  await jumpToSection(page, fixtures.runningRunId, 'Observability', 'run-detail-observability-heading');

  await expect(timelineLink).not.toHaveAttribute('aria-current', 'location');
});

test.describe('mobile section nav', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('mobile jump nav supports section jumps with hash updates', async ({ page }) => {
    const fixtures = await seedLifecycleFixtures(page);

    await openRunDetail(page, fixtures.runningRunId);

    const sectionNav = page.getByRole('navigation', { name: 'Run detail sections' });
    await expect(sectionNav).toBeVisible();

    await jumpToSection(page, fixtures.runningRunId, 'Stream', 'run-detail-stream-heading');
    await jumpToSection(page, fixtures.runningRunId, 'Focus', 'run-detail-operator-focus-heading');
  });
});

test('preserves skip-link and main landmark semantics on run detail', async ({ page }) => {
  const fixtures = await seedLifecycleFixtures(page);

  await openRunDetail(page, fixtures.runningRunId);

  const skipLink = page.getByRole('link', { name: 'Skip to main content', exact: true });
  const main = page.getByRole('main');

  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await expect(main).toHaveCount(1);
  await expect(main).toHaveAttribute('id', 'main-content');
});
