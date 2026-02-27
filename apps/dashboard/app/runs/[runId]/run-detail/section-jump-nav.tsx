'use client';

import { useEffect, useMemo, useState, type MouseEvent } from 'react';

const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';
const INTERSECTION_OBSERVER_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];

export type RunDetailSectionJumpNavSection = Readonly<{
  id: string;
  label: string;
}>;

export type RunDetailSectionJumpNavProps = Readonly<{
  sections: readonly RunDetailSectionJumpNavSection[];
  ariaLabel?: string;
}>;

function resolveSectionIdFromHash(
  sections: readonly RunDetailSectionJumpNavSection[],
): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const hash = window.location.hash;
  if (!hash.startsWith('#') || hash.length <= 1) {
    return null;
  }

  let targetId = hash.slice(1);
  try {
    targetId = decodeURIComponent(targetId);
  } catch {
    return null;
  }

  return sections.some(section => section.id === targetId) ? targetId : null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches;
}

function supportsIntersectionObserver(): boolean {
  return typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function';
}

export function RunDetailSectionJumpNav({
  sections,
  ariaLabel = 'Run detail sections',
}: RunDetailSectionJumpNavProps) {
  const sectionList = useMemo(
    () => sections.filter(section => section.id.trim().length > 0),
    [sections],
  );
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  useEffect(() => {
    if (sectionList.length === 0) {
      setActiveSectionId(null);
      return;
    }

    const sectionIdFromHash = resolveSectionIdFromHash(sectionList);
    setActiveSectionId(sectionIdFromHash ?? sectionList[0]?.id ?? null);
  }, [sectionList]);

  useEffect(() => {
    if (sectionList.length === 0 || typeof window === 'undefined') {
      return;
    }

    if (!supportsIntersectionObserver()) {
      const updateFromHash = () => {
        const sectionIdFromHash = resolveSectionIdFromHash(sectionList);
        if (sectionIdFromHash) {
          setActiveSectionId(sectionIdFromHash);
        }
      };

      updateFromHash();
      window.addEventListener('hashchange', updateFromHash);
      return () => {
        window.removeEventListener('hashchange', updateFromHash);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const intersectingEntries = entries
          .filter(entry => entry.isIntersecting && entry.target instanceof HTMLElement)
          .sort((left, right) => {
            const topDelta = left.boundingClientRect.top - right.boundingClientRect.top;
            if (topDelta !== 0) {
              return topDelta;
            }

            return right.intersectionRatio - left.intersectionRatio;
          });
        const nextActiveEntry = intersectingEntries[0];

        if (nextActiveEntry && nextActiveEntry.target instanceof HTMLElement) {
          setActiveSectionId(nextActiveEntry.target.id);
        }
      },
      {
        rootMargin: '-20% 0px -65% 0px',
        threshold: INTERSECTION_OBSERVER_THRESHOLDS,
      },
    );

    for (const section of sectionList) {
      const targetElement = document.getElementById(section.id);
      if (targetElement) {
        observer.observe(targetElement);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [sectionList]);

  const handleSectionLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    sectionId: string,
  ): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const targetElement = document.getElementById(sectionId);
    if (!targetElement) {
      return;
    }

    event.preventDefault();
    targetElement.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
    setActiveSectionId(sectionId);

    if (typeof window !== 'undefined') {
      if (typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', `#${sectionId}`);
      } else {
        window.location.hash = sectionId;
      }
    }
  };

  if (sectionList.length === 0) {
    return null;
  }

  return (
    <nav className="run-detail-section-jump-nav" aria-label={ariaLabel}>
      <ul className="run-detail-section-jump-nav-list">
        {sectionList.map((section) => {
          const isActive = section.id === activeSectionId;

          return (
            <li key={section.id}>
              <a
                className={`run-detail-section-jump-nav-pill${isActive ? ' run-detail-section-jump-nav-pill--active' : ''}`}
                href={`#${section.id}`}
                aria-current={isActive ? 'location' : undefined}
                onClick={(event) => handleSectionLinkClick(event, section.id)}
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
