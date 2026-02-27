import { expect, test, type Locator, type Page } from '@playwright/test';

type LifecycleFixturePayload = {
  runningRunId: number;
  pausedRunId: number;
  failedRunId: number;
  failedRunNodeId: number;
};

type RunDetailSectionId = 'focus' | 'timeline' | 'stream' | 'observability';

const RUN_DETAIL_SECTIONS = [
  { id: 'focus', label: 'Focus' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'stream', label: 'Stream' },
  { id: 'observability', label: 'Observability' },
] as const satisfies readonly { id: RunDetailSectionId; label: string }[];

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

async function resolveViewportTopDistanceFromSection(page: Page, sectionId: RunDetailSectionId): Promise<number> {
  return page.locator(`section#${sectionId}`).evaluate((element) => Math.abs(element.getBoundingClientRect().top));
}

async function scrollSectionIntoView(page: Page, sectionId: RunDetailSectionId): Promise<void> {
  await page
    .locator(`section#${sectionId}`)
    .evaluate((element) => element.scrollIntoView({ behavior: 'auto', block: 'start' }));
}

async function resolveActiveSectionLabel(nav: Locator): Promise<string | null> {
  return nav.evaluate((element) => element.querySelector<HTMLAnchorElement>('a[aria-current="location"]')?.textContent?.trim() ?? null);
}

async function verifySectionNavBehavior(page: Page): Promise<void> {
  const fixtures = await seedLifecycleFixtures(page);
  await openRunDetail(page, fixtures.failedRunId);

  const nav = page.getByRole('navigation', { name: 'Run detail sections' });
  await expect(nav).toBeVisible();

  for (const section of RUN_DETAIL_SECTIONS) {
    const link = nav.getByRole('link', { name: section.label, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `#${section.id}`);
  }

  for (const section of RUN_DETAIL_SECTIONS) {
    const topDistanceBefore = await resolveViewportTopDistanceFromSection(page, section.id);
    const link = nav.getByRole('link', { name: section.label, exact: true });

    await link.click();

    await expect.poll(() => new URL(page.url()).hash).toBe(`#${section.id}`);
    await expect(page.locator(`section#${section.id}`)).toBeInViewport();

    if (topDistanceBefore > 40) {
      await expect
        .poll(() => resolveViewportTopDistanceFromSection(page, section.id))
        .toBeLessThan(topDistanceBefore);
    }
  }

  await nav.getByRole('link', { name: 'Focus', exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#focus');
  await expect(nav.getByRole('link', { name: 'Focus', exact: true })).toHaveAttribute('aria-current', 'location');

  await scrollSectionIntoView(page, 'observability');
  await expect.poll(() => resolveActiveSectionLabel(nav)).toMatch(/^(Timeline|Stream|Observability)$/);
  await expect.poll(() => new URL(page.url()).hash).toBe('#focus');

  await scrollSectionIntoView(page, 'focus');
  await expect.poll(() => resolveActiveSectionLabel(nav)).toBe('Focus');
  await expect.poll(() => new URL(page.url()).hash).toBe('#focus');
}

test('supports run detail section jump navigation on desktop', async ({ page }) => {
  await verifySectionNavBehavior(page);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('supports run detail section jump navigation on mobile', async ({ page }) => {
    await verifySectionNavBehavior(page);
  });
});
