// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, Panel, StatusBadge, Tabs, type TabItem } from './primitives';

const ITEMS: readonly TabItem[] = [
  { href: '/runs', label: 'All Runs' },
  { href: '/runs?status=running', label: 'Running' },
];

describe('primitives', () => {
  it('renders status badge text and variant classes', () => {
    render(<StatusBadge status="failed" />);

    const badge = screen.getByText('Failed').closest('[data-status="failed"]');
    expect(badge).toHaveClass('status-badge');
    expect(badge).toHaveClass('status-badge--failed');
  });

  it('renders status badge icon as aria-hidden svg (no glyph text)', () => {
    const { container } = render(<StatusBadge status="completed" />);

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('*')).not.toBeInTheDocument();

    const icon = container.querySelector('svg.status-badge__icon');
    expect(icon).toBeTruthy();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks active tabs using aria-current', () => {
    render(<Tabs items={ITEMS} activeHref="/runs" ariaLabel="Run tabs" />);

    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Running' })).not.toHaveAttribute('aria-current');
  });

  it('renders optional heading ids for Card and Panel headings', () => {
    render(
      <>
        <Card title="Operator focus" headingId="run-detail-focus-heading" />
        <Panel title="Timeline" headingId="run-detail-timeline-heading" />
      </>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Operator focus' })).toHaveAttribute(
      'id',
      'run-detail-focus-heading',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Timeline' })).toHaveAttribute(
      'id',
      'run-detail-timeline-heading',
    );
  });

  it('omits heading id when not provided', () => {
    render(
      <>
        <Card title="Operator focus" />
        <Panel title="Timeline" />
      </>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Operator focus' })).not.toHaveAttribute('id');
    expect(screen.getByRole('heading', { level: 3, name: 'Timeline' })).not.toHaveAttribute('id');
  });
});
