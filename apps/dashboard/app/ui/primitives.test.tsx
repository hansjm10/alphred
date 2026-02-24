// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, Tabs, type TabItem } from './primitives';

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

  it('supports cancelled and skipped status variants', () => {
    render(
      <>
        <StatusBadge status="cancelled" />
        <StatusBadge status="skipped" />
      </>,
    );

    expect(screen.getByText('Cancelled').closest('[data-status="cancelled"]')).toHaveClass(
      'status-badge--cancelled',
    );
    expect(screen.getByText('Skipped').closest('[data-status="skipped"]')).toHaveClass(
      'status-badge--skipped',
    );
  });

  it('marks active tabs using aria-current', () => {
    render(<Tabs items={ITEMS} activeHref="/runs" ariaLabel="Run tabs" />);

    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Running' })).not.toHaveAttribute('aria-current');
  });
});
