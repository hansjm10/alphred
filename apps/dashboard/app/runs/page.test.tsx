// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RunsPage from './page';

describe('RunsPage', () => {
  it('renders run status tabs and lifecycle rows', () => {
    render(<RunsPage />);

    expect(screen.getByRole('heading', { name: 'Run lifecycle' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Run status filters' })).toBeInTheDocument();
    expect(screen.getByText('#412 demo-tree')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute(
      'href',
      '/runs?status=running',
    );
    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the running tab as current when status filter is running', () => {
    render(<RunsPage searchParams={{ status: 'running' }} />);

    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'All Runs' })).not.toHaveAttribute('aria-current');
  });

  it('marks the failed tab as current when status filter is failed', () => {
    render(<RunsPage searchParams={{ status: 'failed' }} />);

    expect(screen.getByRole('link', { name: 'Failed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'All Runs' })).not.toHaveAttribute('aria-current');
  });

  it('falls back to all runs tab for unknown status filters', () => {
    render(<RunsPage searchParams={{ status: 'paused' }} />);

    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Running' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Failed' })).not.toHaveAttribute('aria-current');
  });
});
