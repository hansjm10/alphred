'use client';

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { RUN_DETAIL_SECTIONS, type RunDetailSectionKey, type RunDetailSectionMetadata } from './types';

export const RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX = 128;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

type TrackedSection = Readonly<{
  section: RunDetailSectionMetadata;
  heading: HTMLElement;
}>;
type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

function resolveTrackedSections(sections: readonly RunDetailSectionMetadata[]): readonly TrackedSection[] {
  return sections
    .map((section) => {
      const heading = document.getElementById(section.headingId);
      if (!heading) {
        return null;
      }

      return {
        section,
        heading,
      };
    })
    .filter((tracked): tracked is TrackedSection => tracked !== null);
}

export function resolveActiveRunDetailSection(
  sections: readonly RunDetailSectionMetadata[],
  thresholdPx: number = RUN_DETAIL_SCROLL_SPY_THRESHOLD_PX,
): RunDetailSectionKey {
  const defaultKey = sections[0]?.key;
  if (!defaultKey) {
    throw new Error('Run detail sections are required to resolve active section.');
  }

  const trackedSections = resolveTrackedSections(sections);
  if (trackedSections.length === 0) {
    return defaultKey;
  }

  if (window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight) {
    return trackedSections[trackedSections.length - 1].section.key;
  }

  let activeSectionKey = trackedSections[0].section.key;
  for (const trackedSection of trackedSections) {
    if (trackedSection.heading.getBoundingClientRect().top <= thresholdPx) {
      activeSectionKey = trackedSection.section.key;
      continue;
    }

    break;
  }

  return activeSectionKey;
}

function resolveInitialReducedMotionPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function isModifiedClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey;
}

export function RunDetailSectionJumpNav() {
  const [activeSection, setActiveSection] = useState<RunDetailSectionKey>(RUN_DETAIL_SECTIONS[0].key);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(resolveInitialReducedMotionPreference);

  const updateActiveSection = useCallback(() => {
    const nextActiveSection = resolveActiveRunDetailSection(RUN_DETAIL_SECTIONS);

    setActiveSection((current) => (current === nextActiveSection ? current : nextActiveSection));
  }, []);

  useEffect(() => {
    updateActiveSection();

    window.addEventListener('scroll', updateActiveSection, {
      passive: true,
    });
    window.addEventListener('resize', updateActiveSection);

    return () => {
      window.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [updateActiveSection]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY) as LegacyMediaQueryList;
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    setPrefersReducedMotion(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => {
        mediaQuery.removeEventListener('change', handleChange);
      };
    }

    mediaQuery.addListener?.(handleChange);
    return () => {
      mediaQuery.removeListener?.(handleChange);
    };
  }, []);

  const handleSectionClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, section: RunDetailSectionMetadata) => {
      if (event.defaultPrevented || isModifiedClick(event)) {
        return;
      }

      const heading = document.getElementById(section.headingId);
      if (!heading || typeof heading.scrollIntoView !== 'function') {
        return;
      }

      event.preventDefault();
      heading.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });

      if (typeof window.history.pushState === 'function') {
        window.history.pushState(null, '', `#${section.headingId}`);
      } else {
        window.location.hash = section.headingId;
      }

      setActiveSection(section.key);
    },
    [prefersReducedMotion],
  );

  return (
    <nav aria-label="Run detail sections" className="run-detail-section-jump-nav">
      <ul className="run-detail-section-jump-nav__list">
        {RUN_DETAIL_SECTIONS.map((section) => {
          const isActive = section.key === activeSection;

          return (
            <li key={section.key}>
              <a
                href={`#${section.headingId}`}
                className={`run-detail-section-jump-nav__link${isActive ? ' run-detail-section-jump-nav__link--active' : ''}`}
                aria-current={isActive ? 'location' : undefined}
                onClick={(event) => {
                  handleSectionClick(event, section);
                }}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
