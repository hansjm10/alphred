'use client';

export type RunDetailSection = Readonly<{
  id: string;
  label: string;
}>;

export const RUN_DETAIL_SECTIONS = [
  {
    id: 'run-section-focus',
    label: 'Focus',
  },
  {
    id: 'run-section-timeline',
    label: 'Timeline',
  },
  {
    id: 'run-section-stream',
    label: 'Stream',
  },
  {
    id: 'run-section-observability',
    label: 'Observability',
  },
] as const satisfies readonly RunDetailSection[];

export function RunDetailSectionJumpNav() {
  return (
    <nav aria-label="Run detail sections" className="run-detail-section-jump-nav">
      <ul className="run-detail-section-jump-nav__list">
        {RUN_DETAIL_SECTIONS.map((section) => (
          <li key={section.id}>
            <a href={`#${section.id}`}>{section.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
