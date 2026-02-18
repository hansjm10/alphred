// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppShell from './app-shell';
import { createCheckingGitHubAuthGate, createGitHubAuthErrorGate, createGitHubAuthGate } from './github-auth';

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
      <AppShell authGate={createGitHubAuthGate({
        authenticated: true,
        user: 'octocat',
        scopes: ['repo'],
        error: null,
      })}>
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
      <AppShell authGate={createGitHubAuthGate({
        authenticated: true,
        user: 'octocat',
        scopes: ['repo'],
        error: null,
      })}>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();
  });

  it('switches the launch CTA to remediation when auth is degraded', () => {
    testPathname.value = '/';
    render(
      <AppShell authGate={createGitHubAuthErrorGate('failed to check auth')}>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
    expect(screen.queryByRole('link', { name: 'Launch Run' })).not.toBeInTheDocument();
  });

  it('shows disabled checking action while auth status is loading', () => {
    testPathname.value = '/';
    render(
      <AppShell authGate={createCheckingGitHubAuthGate()}>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('button', { name: 'Checking auth...' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Launch Run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).not.toBeInTheDocument();
  });

  it('uses remediation CTA for explicit unauthenticated state', () => {
    testPathname.value = '/';
    render(
      <AppShell authGate={createGitHubAuthGate({
        authenticated: false,
        user: null,
        scopes: [],
        error: 'Run gh auth login before launching.',
      })}>
        <p>route content</p>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
    expect(screen.queryByRole('link', { name: 'Launch Run' })).not.toBeInTheDocument();
    expect(screen.getByText('Unauthenticated')).toBeInTheDocument();
  });
});
