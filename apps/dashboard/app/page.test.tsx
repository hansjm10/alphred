// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Page from './page';

describe('Dashboard Page', () => {
  it('renders the dashboard home content', () => {
    render(<Page />);

    expect(screen.getByRole('heading', { name: 'System readiness' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Global readiness' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check Auth' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('renders empty-state actions when there are no active runs', () => {
    render(<Page activeRuns={[]} />);

    expect(screen.getByRole('heading', { name: 'No active runs' })).toBeInTheDocument();
    expect(
      screen.getByText('Connect GitHub, sync a repository, and launch your first run.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });
});
