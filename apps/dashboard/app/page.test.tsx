// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page, { OverviewPageContent } from './page';
import type { GitHubAuthGate } from './ui/github-auth';
import { createCheckingGitHubAuthGate, createGitHubAuthErrorGate, createGitHubAuthGate } from './ui/github-auth';

const { loadGitHubAuthGateMock } = vi.hoisted(() => ({
  loadGitHubAuthGateMock: vi.fn(),
}));

vi.mock('./ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

describe('Dashboard Page', () => {
  beforeEach(() => {
    loadGitHubAuthGateMock.mockReset();
  });

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

  it('loads auth gate for the async page export when no authGate prop is provided', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await Page({ activeRuns: [] })) as ReactElement<{
      activeRuns: readonly unknown[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(OverviewPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });

  it('uses provided authGate without calling loader in async page export', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });

    const root = (await Page({ activeRuns: [], authGate })) as ReactElement<{
      activeRuns: readonly unknown[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(OverviewPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });
});
