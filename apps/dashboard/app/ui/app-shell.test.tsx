// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppShell from './app-shell';

const testPathname = {
  value: '/',
};

vi.mock('next/navigation', () => ({
  usePathname: () => testPathname.value,
}));

describe('AppShell', () => {
  it('renders shell landmarks and primary navigation links', () => {
    testPathname.value = '/';
    render(
      <AppShell>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const navQueries = within(nav);

    expect(navQueries.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(navQueries.getByRole('link', { name: 'Repositories' })).toBeInTheDocument();
    expect(navQueries.getByRole('link', { name: 'Runs' })).toBeInTheDocument();
    expect(navQueries.getByRole('link', { name: 'Integrations' })).toBeInTheDocument();
  });

  it('marks the matching route as current', () => {
    testPathname.value = '/runs/412';
    render(
      <AppShell>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();
  });
});
