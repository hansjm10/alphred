'use client';

import type { MouseEvent } from 'react';

export const RUN_DETAIL_SECTION_JUMP_ITEMS = [
  {
    key: 'focus',
    label: 'Focus',
    targetId: 'run-detail-operator-focus-heading',
    hash: '#run-detail-operator-focus-heading',
  },
  {
    key: 'timeline',
    label: 'Timeline',
    targetId: 'run-detail-timeline-heading',
    hash: '#run-detail-timeline-heading',
  },
  {
    key: 'stream',
    label: 'Stream',
    targetId: 'run-detail-stream-heading',
    hash: '#run-detail-stream-heading',
  },
  {
    key: 'observability',
    label: 'Observability',
    targetId: 'run-detail-observability-heading',
    hash: '#run-detail-observability-heading',
  },
] as const;

export type RunDetailSectionJumpKey = (typeof RUN_DETAIL_SECTION_JUMP_ITEMS)[number]['key'];

type RunDetailSectionJumpNavProps = Readonly<{
  activeSection?: RunDetailSectionJumpKey | null;
  className?: string;
}>;

function shouldHandleAnchorClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented
    && event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && event.currentTarget.target !== '_blank'
  );
}

function resolveScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined') {
    return 'auto';
  }

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function buildNavClassName(className?: string): string {
  return className ? `run-section-jump-nav ${className}` : 'run-section-jump-nav';
}

export function RunDetailSectionJumpNav({
  activeSection = null,
  className,
}: RunDetailSectionJumpNavProps) {
  const handleAnchorClick = (
    event: MouseEvent<HTMLAnchorElement>,
    item: (typeof RUN_DETAIL_SECTION_JUMP_ITEMS)[number],
  ): void => {
    if (!shouldHandleAnchorClick(event)) {
      return;
    }

    const target = document.getElementById(item.targetId);
    if (!target) {
      return;
    }

    event.preventDefault();

    if (window.location.hash !== item.hash) {
      window.history.pushState(null, '', item.hash);
    }

    target.scrollIntoView({
      behavior: resolveScrollBehavior(),
      block: 'start',
    });
  };

  return (
    <nav aria-label="Run detail sections" className={buildNavClassName(className)}>
      <ul className="run-section-jump-nav__list">
        {RUN_DETAIL_SECTION_JUMP_ITEMS.map((item) => (
          <li key={item.key}>
            <a
              className="run-section-jump-nav__link"
              href={item.hash}
              aria-current={activeSection === item.key ? 'location' : undefined}
              onClick={(event) => {
                handleAnchorClick(event, item);
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
