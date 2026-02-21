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
});
