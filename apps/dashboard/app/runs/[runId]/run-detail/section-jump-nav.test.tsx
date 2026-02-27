// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunDetailSectionJumpNav,
  type RunDetailSectionJumpNavSection,
} from './section-jump-nav';

const SECTION_CONFIG: readonly RunDetailSectionJumpNavSection[] = [
  { id: 'focus', label: 'Focus' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'stream', label: 'Stream' },
  { id: 'observability', label: 'Observability' },
];

type MockIntersectionObserverInstance = Readonly<{
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}>;

const scrollIntoViewMock = vi.fn();
let mockIntersectionObserverInstances: MockIntersectionObserverInstance[] = [];
let prefersReducedMotion = false;

function installMatchMediaMock(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string): MediaQueryList => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? prefersReducedMotion : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
}

function installIntersectionObserverMock(): void {
  class MockIntersectionObserver {
    readonly disconnect = vi.fn();
    readonly observe = vi.fn();
    readonly root = null;
    readonly rootMargin = '';
    readonly takeRecords = vi.fn(() => []);
    readonly thresholds = [];
    readonly unobserve = vi.fn();

    constructor(public readonly callback: IntersectionObserverCallback) {
      mockIntersectionObserverInstances.push({
        callback,
        observe: this.observe,
        disconnect: this.disconnect,
      });
    }
  }

  vi.stubGlobal(
    'IntersectionObserver',
    MockIntersectionObserver as unknown as typeof IntersectionObserver,
  );
}

function createIntersectionEntry(
  target: Element,
  options: Readonly<{
    isIntersecting?: boolean;
    top?: number;
  }> = {},
): IntersectionObserverEntry {
  const top = options.top ?? 0;
  const isIntersecting = options.isIntersecting ?? true;
  const rect = {
    x: 0,
    y: top,
    top,
    left: 0,
    bottom: top + 80,
    right: 480,
    width: 480,
    height: 80,
    toJSON: () => ({}),
  } as DOMRectReadOnly;

  return {
    time: 0,
    target,
    isIntersecting,
    intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: rect,
    intersectionRect: rect,
    rootBounds: null,
  };
}

function renderJumpNavWithTargets(): void {
  render(
    <>
      <RunDetailSectionJumpNav sections={SECTION_CONFIG} />
      <section id="focus">
        <h3>Focus section</h3>
      </section>
      <section id="timeline">
        <h3>Timeline section</h3>
      </section>
      <section id="stream">
        <h3>Stream section</h3>
      </section>
      <section id="observability">
        <h3>Observability section</h3>
      </section>
    </>,
  );
}

beforeEach(() => {
  prefersReducedMotion = false;
  mockIntersectionObserverInstances = [];
  scrollIntoViewMock.mockReset();
  window.history.replaceState(null, '', '/runs/412');
  installMatchMediaMock();
  installIntersectionObserverMock();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RunDetailSectionJumpNav', () => {
  it('renders a semantic nav with section pills from the section config', () => {
    renderJumpNavWithTargets();

    const nav = screen.getByRole('navigation', { name: 'Run detail sections' });
    const navQueries = within(nav);

    expect(navQueries.getByRole('link', { name: 'Focus' })).toHaveAttribute('href', '#focus');
    expect(navQueries.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '#timeline');
    expect(navQueries.getByRole('link', { name: 'Stream' })).toHaveAttribute('href', '#stream');
    expect(navQueries.getByRole('link', { name: 'Observability' })).toHaveAttribute('href', '#observability');
    expect(navQueries.getByRole('link', { name: 'Focus' })).toHaveAttribute('aria-current', 'location');
  });

  it('intercepts in-page link clicks and scrolls to the target section with smooth behavior', async () => {
    const user = userEvent.setup();
    renderJumpNavWithTargets();

    await user.click(screen.getByRole('link', { name: 'Timeline' }));

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' });
    expect(window.location.hash).toBe('#timeline');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');
  });

  it('disables smooth scrolling when reduced motion is preferred', async () => {
    prefersReducedMotion = true;
    const user = userEvent.setup();
    renderJumpNavWithTargets();

    await user.click(screen.getByRole('link', { name: 'Stream' }));

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('updates the active pill as observed sections intersect', () => {
    renderJumpNavWithTargets();

    const observerInstance = mockIntersectionObserverInstances[0];
    expect(observerInstance).toBeDefined();
    expect(observerInstance?.observe).toHaveBeenCalledTimes(4);

    const timelineTarget = document.getElementById('timeline');
    const streamTarget = document.getElementById('stream');
    expect(timelineTarget).not.toBeNull();
    expect(streamTarget).not.toBeNull();

    act(() => {
      observerInstance?.callback(
        [createIntersectionEntry(timelineTarget as Element, { top: 120 })],
        {} as IntersectionObserver,
      );
    });

    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');

    act(() => {
      observerInstance?.callback(
        [createIntersectionEntry(streamTarget as Element, { top: 120 })],
        {} as IntersectionObserver,
      );
    });

    expect(screen.getByRole('link', { name: 'Stream' })).toHaveAttribute('aria-current', 'location');
  });

  it('falls back to hash-based active state when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    window.history.replaceState(null, '', '/runs/412#observability');
    renderJumpNavWithTargets();

    expect(screen.getByRole('link', { name: 'Observability' })).toHaveAttribute('aria-current', 'location');

    act(() => {
      window.location.hash = '#timeline';
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'location');
  });

  it('preserves default anchor fallback behavior when a target section is missing', async () => {
    const user = userEvent.setup();
    render(<RunDetailSectionJumpNav sections={SECTION_CONFIG} />);

    await user.click(screen.getByRole('link', { name: 'Observability' }));

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#observability');
  });
});
