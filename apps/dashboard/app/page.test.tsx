// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverviewPageContent } from './page';
import { createCheckingGitHubAuthGate, createGitHubAuthErrorGate, createGitHubAuthGate } from './ui/github-auth';

describe('Dashboard Page', () => {
  it('renders the dashboard home content', () => {
    render(
      <OverviewPageContent
        activeRuns={[]}
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'System readiness' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Global readiness' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check Auth' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('renders empty-state actions when there are no active runs', () => {
    render(
      <OverviewPageContent
        activeRuns={[]}
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No active runs' })).toBeInTheDocument();
    expect(
      screen.getByText('Connect GitHub, sync a repository, and launch your first run.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect GitHub' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('gates launch CTA and surfaces remediation when auth check fails', () => {
    render(
      <OverviewPageContent
        activeRuns={[]}
        authGate={createGitHubAuthErrorGate('Unable to verify GitHub auth')}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'Connect GitHub' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Launch Run' })).not.toBeInTheDocument();
    expect(screen.getByText('gh auth login')).toBeInTheDocument();
  });

  it('renders checking state CTA while auth is being verified', () => {
    render(
      <OverviewPageContent
        activeRuns={[]}
        authGate={createCheckingGitHubAuthGate()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Checking auth...' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Launch Run' })).not.toBeInTheDocument();
  });
});
