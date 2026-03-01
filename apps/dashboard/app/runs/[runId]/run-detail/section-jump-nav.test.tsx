// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_DETAIL_SECTION_METADATA, RUN_DETAIL_SECTIONS, type RunDetailSectionKey } from './types';
import {
  RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX,
  RunDetailSectionJumpNav,
} from './section-jump-nav';

const defaultSectionTops: Record<RunDetailSectionKey, number> = {
  focus: 180,
  timeline: 720,
  stream: 1280,
  observability: 1860,
};

const headingTopById = new Map<string, number>();
let reducedMotionMediaQuery: MediaQueryList | null = null;

function setSectionTops(overrides: Partial<Record<RunDetailSectionKey, number>> = {}): void {
  for (const section of RUN_DETAIL_SECTIONS) {
    headingTopById.set(section.headingId, overrides[section.key] ?? defaultSectionTops[section.key]);
  }
}

function createMediaQueryList(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
}

function stubPrefersReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const mediaQuery = createMediaQueryList(query === '(prefers-reduced-motion: reduce)' ? matches : false);
      if (query === '(prefers-reduced-motion: reduce)') {
        reducedMotionMediaQuery = mediaQuery;
      }
      return mediaQuery;
    }),
  );
}

function renderSectionJumpNav() {
  return render(
    <>
      <RunDetailSectionJumpNav />
      {RUN_DETAIL_SECTIONS.map((section) => (
        <section key={section.key}>
          <h3 id={section.headingId}>{section.label}</h3>
        </section>
      ))}
    </>,
  );
}

describe('RunDetailSectionJumpNav', () => {
  beforeEach(() => {
    stubPrefersReducedMotion(false);
    setSectionTops();

    Object.defineProperty(window, 'innerHeight', {
      value: 900,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'scrollY', {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3_000,
      configurable: true,
      writable: true,
    });

    window.history.replaceState(null, '', '/runs/412');

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
      const top = headingTopById.get(this.id) ?? 0;
      return {
        x: 0,
        y: top,
        width: 100,
        height: 32,
        top,
        right: 100,
        bottom: top + 32,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    headingTopById.clear();
    reducedMotionMediaQuery = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders canonical section links using run detail metadata', () => {
    renderSectionJumpNav();

    for (const section of RUN_DETAIL_SECTIONS) {
      const link = screen.getByRole('link', {
        name: section.label,
      });
      expect(link).toHaveAttribute('href', `#${section.headingId}`);
    }
  });

  it('updates aria-current using deterministic threshold logic on scroll and resize', () => {
    setSectionTops({
      focus: -120,
      timeline: RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX + 1,
      stream: 760,
      observability: 1240,
    });

    renderSectionJumpNav();

    const focusLink = screen.getByRole('link', { name: 'Focus' });
    const timelineLink = screen.getByRole('link', { name: 'Timeline' });

    expect(focusLink).toHaveAttribute('aria-current', 'location');
    expect(timelineLink).not.toHaveAttribute('aria-current');

    act(() => {
      setSectionTops({
        focus: -220,
        timeline: RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX,
        stream: 620,
        observability: 1100,
      });
      window.dispatchEvent(new Event('scroll'));
    });

    expect(timelineLink).toHaveAttribute('aria-current', 'location');
    expect(focusLink).not.toHaveAttribute('aria-current');

    act(() => {
      setSectionTops({
        focus: -40,
        timeline: RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX + 1,
        stream: 660,
        observability: 1120,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(focusLink).toHaveAttribute('aria-current', 'location');
    expect(timelineLink).not.toHaveAttribute('aria-current');
  });

  it('smooth scrolls to the selected section while retaining anchor hash updates', async () => {
    const user = userEvent.setup();
    renderSectionJumpNav();

    const streamHeading = document.getElementById(RUN_DETAIL_SECTION_METADATA.stream.headingId);
    expect(streamHeading).not.toBeNull();

    const scrollIntoView = vi.fn();
    Object.defineProperty(streamHeading!, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });

    await user.click(screen.getByRole('link', { name: 'Stream' }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
    expect(window.location.hash).toBe(`#${RUN_DETAIL_SECTION_METADATA.stream.headingId}`);
    expect(screen.getByRole('link', { name: 'Stream' })).toHaveAttribute('aria-current', 'location');
  });

  it('marks the last section active when the viewport reaches the page bottom', () => {
    renderSectionJumpNav();

    act(() => {
      Object.defineProperty(window, 'scrollY', {
        value: 2_100,
        configurable: true,
        writable: true,
      });
      window.dispatchEvent(new Event('scroll'));
    });

    expect(screen.getByRole('link', { name: 'Observability' })).toHaveAttribute('aria-current', 'location');
  });

  it('disables animated scrolling when prefers-reduced-motion is enabled', async () => {
    stubPrefersReducedMotion(true);
    const user = userEvent.setup();
    renderSectionJumpNav();

    const observabilityHeading = document.getElementById(RUN_DETAIL_SECTION_METADATA.observability.headingId);
    expect(observabilityHeading).not.toBeNull();

    const scrollIntoView = vi.fn();
    Object.defineProperty(observabilityHeading!, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });

    await user.click(screen.getByRole('link', { name: 'Observability' }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
    });
  });

  it('removes scroll and resize listeners on unmount', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderSectionJumpNav();

    const scrollHandler = addEventListenerSpy.mock.calls.find((call) => call[0] === 'scroll')?.[1];
    const resizeHandler = addEventListenerSpy.mock.calls.find((call) => call[0] === 'resize')?.[1];

    expect(scrollHandler).toBeTypeOf('function');
    expect(resizeHandler).toBeTypeOf('function');

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', scrollHandler);
    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', resizeHandler);
  });

  it('removes prefers-reduced-motion listeners on unmount', () => {
    const { unmount } = renderSectionJumpNav();
    expect(reducedMotionMediaQuery).not.toBeNull();

    const addCalls = vi.mocked(reducedMotionMediaQuery!.addEventListener).mock.calls;
    const removeCalls = vi.mocked(reducedMotionMediaQuery!.removeEventListener).mock.calls;
    expect(addCalls.length).toBeGreaterThan(0);

    const changeHandler = addCalls[0]?.[1];
    unmount();

    expect(removeCalls).toContainEqual(['change', changeHandler]);
  });
});
