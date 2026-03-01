import { expect, test, type Page } from '@playwright/test';

type LifecycleFixturePayload = {
  runningRunId: number;
};

type ViewportFixture = Readonly<{
  name: 'desktop' | 'mobile';
  size: {
    width: number;
    height: number;
  };
}>;

const VIEWPORTS: readonly ViewportFixture[] = [
  {
    name: 'desktop',
    size: {
      width: 1366,
      height: 900,
    },
  },
  {
    name: 'mobile',
    size: {
      width: 390,
      height: 844,
    },
  },
];

const RUN_DETAIL_SECTION_IDS = {
  focus: 'run-detail-focus-heading',
  stream: 'run-detail-stream-heading',
  observability: 'run-detail-observability-heading',
} as const;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function seedLifecycleFixture(page: Page): Promise<LifecycleFixturePayload> {
  const response = await page.request.post('/test/lifecycle-fixtures');
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as Partial<LifecycleFixturePayload>;
  expect(isPositiveInteger(payload.runningRunId)).toBe(true);
  if (!isPositiveInteger(payload.runningRunId)) {
    throw new Error('Expected /test/lifecycle-fixtures to return runningRunId.');
  }

  return {
    runningRunId: payload.runningRunId,
  };
}

async function openRunDetail(page: Page, runId: number, viewport: ViewportFixture): Promise<void> {
  await page.setViewportSize(viewport.size);
  await page.emulateMedia({
    reducedMotion: 'reduce',
  });
  await page.goto(`/runs/${runId}`);
  await page.addStyleTag({
    content: 'html { scroll-behavior: auto !important; }',
  });
  await expect(page.getByRole('heading', { name: `Run #${runId}` })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`supports run detail section jump links on ${viewport.name}`, async ({ page }) => {
    const fixtures = await seedLifecycleFixture(page);
    await openRunDetail(page, fixtures.runningRunId, viewport);

    const sectionNav = page.getByRole('navigation', {
      name: 'Run detail sections',
    });
    await expect(sectionNav).toBeVisible();

    const focusLink = sectionNav.getByRole('link', { name: 'Focus', exact: true });
    const streamLink = sectionNav.getByRole('link', { name: 'Stream', exact: true });
    const observabilityLink = sectionNav.getByRole('link', { name: 'Observability', exact: true });

    await expect(focusLink).toHaveAttribute('href', `#${RUN_DETAIL_SECTION_IDS.focus}`);
    await expect(streamLink).toHaveAttribute('href', `#${RUN_DETAIL_SECTION_IDS.stream}`);
    await expect(observabilityLink).toHaveAttribute('href', `#${RUN_DETAIL_SECTION_IDS.observability}`);

    await expect(focusLink).toHaveAttribute('aria-current', 'location');

    await streamLink.click();

    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .toBe(`#${RUN_DETAIL_SECTION_IDS.stream}`);

    const streamJumpPosition = await page.evaluate((headingId) => {
      const heading = document.getElementById(headingId);
      if (!heading) {
        return null;
      }

      const { top } = heading.getBoundingClientRect();
      return {
        top,
        scrollY: window.scrollY,
        innerHeight: window.innerHeight,
      };
    }, RUN_DETAIL_SECTION_IDS.stream);

    expect(streamJumpPosition).not.toBeNull();
    if (!streamJumpPosition) {
      throw new Error('Expected stream section heading to exist after section jump.');
    }

    expect(streamJumpPosition.scrollY).toBeGreaterThan(0);
    expect(streamJumpPosition.top).toBeLessThanOrEqual(streamJumpPosition.innerHeight);

    await page.evaluate(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'auto',
      });
      window.dispatchEvent(new Event('scroll'));
    });

    await expect.poll(async () => observabilityLink.getAttribute('aria-current')).toBe('location');
    await expect(focusLink).not.toHaveAttribute('aria-current', 'location');
  });
}
