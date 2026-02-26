export const RUN_DETAIL_SECTION_IDS = {
  focus: 'run-detail-focus',
  timeline: 'run-detail-timeline',
  stream: 'run-detail-stream',
  observability: 'run-detail-observability',
} as const;

export type RunDetailSectionId = (typeof RUN_DETAIL_SECTION_IDS)[keyof typeof RUN_DETAIL_SECTION_IDS];

export const RUN_DETAIL_SECTION_NAV_ITEMS = [
  {
    id: RUN_DETAIL_SECTION_IDS.focus,
    label: 'Focus',
  },
  {
    id: RUN_DETAIL_SECTION_IDS.timeline,
    label: 'Timeline',
  },
  {
    id: RUN_DETAIL_SECTION_IDS.stream,
    label: 'Stream',
  },
  {
    id: RUN_DETAIL_SECTION_IDS.observability,
    label: 'Observability',
  },
] as const satisfies readonly Readonly<{ id: RunDetailSectionId; label: string }>[];
