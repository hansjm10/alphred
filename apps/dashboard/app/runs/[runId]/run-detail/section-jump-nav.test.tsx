// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RUN_DETAIL_SECTIONS, RunDetailSectionJumpNav } from './section-jump-nav';

describe('RunDetailSectionJumpNav', () => {
  it('defines the canonical run detail sections', () => {
    expect(RUN_DETAIL_SECTIONS).toEqual([
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
    ]);
  });

  it('renders exactly four section hash links with expected labels', () => {
    render(<RunDetailSectionJumpNav />);

    const nav = screen.getByRole('navigation', { name: 'Run detail sections' });
    const links = within(nav).getAllByRole('link');

    expect(links).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual(['Focus', 'Timeline', 'Stream', 'Observability']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#run-section-focus',
      '#run-section-timeline',
      '#run-section-stream',
      '#run-section-observability',
    ]);
  });
});
