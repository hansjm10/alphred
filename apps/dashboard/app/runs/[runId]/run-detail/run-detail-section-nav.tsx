'use client';

import { useEffect, useMemo, useState } from 'react';

export type RunDetailSectionAnchor = Readonly<{
  id: string;
  label: string;
}>;

type RunDetailSectionNavProps = Readonly<{
  sections: readonly RunDetailSectionAnchor[];
}>;

function resolveHashSectionId(
  hash: string,
  sectionIds: readonly string[],
): string | null {
  const normalizedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!normalizedHash) {
    return null;
  }

  return sectionIds.includes(normalizedHash) ? normalizedHash : null;
}

function resolveInitialActiveSectionId(sectionIds: readonly string[]): string {
  if (sectionIds.length === 0) {
    return '';
  }

  if (typeof window === 'undefined') {
    return sectionIds[0]!;
  }

  return resolveHashSectionId(window.location.hash, sectionIds) ?? sectionIds[0]!;
}

export function RunDetailSectionNav({ sections }: RunDetailSectionNavProps) {
  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const [activeSectionId, setActiveSectionId] = useState<string>(() => resolveInitialActiveSectionId(sectionIds));

  useEffect(() => {
    setActiveSectionId(resolveInitialActiveSectionId(sectionIds));
  }, [sectionIds]);

  useEffect(() => {
    if (typeof window === 'undefined' || sectionIds.length === 0) {
      return;
    }

    if (typeof window.IntersectionObserver !== 'function') {
      const syncHashSection = () => {
        const hashSectionId = resolveHashSectionId(window.location.hash, sectionIds);
        setActiveSectionId(hashSectionId ?? sectionIds[0]!);
      };

      syncHashSection();
      window.addEventListener('hashchange', syncHashSection);
      return () => {
        window.removeEventListener('hashchange', syncHashSection);
      };
    }

    const targets = sectionIds
      .map((sectionId) => document.getElementById(sectionId))
      .filter((target): target is HTMLElement => target !== null);

    if (targets.length === 0) {
      return;
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        let nextActive: string | null = null;
        let nextRatio = 0;

        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          if (entry.intersectionRatio >= nextRatio) {
            nextActive = (entry.target as HTMLElement).id;
            nextRatio = entry.intersectionRatio;
          }
        }

        if (nextActive === null) {
          return;
        }

        setActiveSectionId((current) => (current === nextActive ? current : nextActive));
      },
      {
        rootMargin: '-104px 0px -45% 0px',
        threshold: [0.15, 0.35, 0.6, 0.85],
      },
    );

    for (const target of targets) {
      observer.observe(target);
    }

    return () => {
      observer.disconnect();
    };
  }, [sectionIds]);

  if (sections.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Run detail section navigation" className="run-detail-section-nav">
      <ol className="run-detail-section-nav__list">
        {sections.map((section) => {
          const active = section.id === activeSectionId;
          const href = `#${section.id}`;

          return (
            <li key={section.id}>
              <a
                href={href}
                className={`run-detail-section-nav__link${active ? ' run-detail-section-nav__link--active' : ''}`}
                aria-current={active ? 'location' : undefined}
                onClick={(event) => {
                  event.preventDefault();

                  const target = document.getElementById(section.id);
                  if (!target) {
                    return;
                  }

                  const prefersReducedMotion =
                    typeof window.matchMedia === 'function' &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

                  target.scrollIntoView({
                    behavior: prefersReducedMotion ? 'auto' : 'smooth',
                    block: 'start',
                  });
                  window.history.replaceState(null, '', href);
                  setActiveSectionId(section.id);
                }}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
