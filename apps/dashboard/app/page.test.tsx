// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page, { OverviewPageContent } from './page';
import type { DashboardRunSummary } from '../src/server/dashboard-contracts';
import type { GitHubAuthGate } from './ui/github-auth';
import { createCheckingGitHubAuthGate, createGitHubAuthErrorGate, createGitHubAuthGate } from './ui/github-auth';

const { loadDashboardRunsMock, loadGitHubAuthGateMock } = vi.hoisted(() => ({
  loadDashboardRunsMock: vi.fn(),
  loadGitHubAuthGateMock: vi.fn(),
}));

vi.mock('./runs/load-dashboard-runs', () => ({
  loadDashboardRuns: loadDashboardRunsMock,
}));

vi.mock('./ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

function createRunSummary(overrides: Partial<DashboardRunSummary> = {}): DashboardRunSummary {
  const id = overrides.id ?? 412;

  return {
    id,
    tree: {
      id: overrides.tree?.id ?? 14,
      treeKey: overrides.tree?.treeKey ?? 'demo-tree',
      version: overrides.tree?.version ?? 1,
      name: overrides.tree?.name ?? 'Demo Tree',
    },
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt === undefined ? '2026-02-17T20:01:00.000Z' : overrides.startedAt,
    completedAt: overrides.completedAt === undefined ? null : overrides.completedAt,
    createdAt: overrides.createdAt ?? '2026-02-17T20:00:00.000Z',
    nodeSummary: {
      pending: overrides.nodeSummary?.pending ?? 0,
      running: overrides.nodeSummary?.running ?? 1,
      completed: overrides.nodeSummary?.completed ?? 0,
      failed: overrides.nodeSummary?.failed ?? 0,
      skipped: overrides.nodeSummary?.skipped ?? 0,
      cancelled: overrides.nodeSummary?.cancelled ?? 0,
    },
  };
}

describe('Dashboard Page', () => {
  beforeEach(() => {
    loadDashboardRunsMock.mockReset();
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

  it('renders active run links from backend-shaped summaries', () => {
    render(
      <OverviewPageContent
        activeRuns={[
          createRunSummary({ id: 412, status: 'running', tree: { id: 1, treeKey: 'demo-tree', version: 1, name: 'Demo Tree' } }),
        ]}
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('link', { name: 'Run #412 Demo Tree' })).toHaveAttribute('href', '/runs/412');
    expect(screen.getByText('Running')).toBeInTheDocument();
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

  it('loads run summaries and auth gate for the async page export when props are omitted', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    const runs = [
      createRunSummary({ id: 412, status: 'running' }),
      createRunSummary({ id: 411, status: 'paused' }),
      createRunSummary({ id: 410, status: 'completed' }),
    ];
    loadDashboardRunsMock.mockResolvedValue(runs);
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await Page()) as ReactElement<{
      activeRuns: readonly DashboardRunSummary[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadDashboardRunsMock).toHaveBeenCalledTimes(1);
    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(OverviewPageContent);
    expect(root.props.activeRuns).toEqual([runs[0], runs[1]]);
    expect(root.props.authGate).toEqual(authGate);
  });

  it('uses provided activeRuns and authGate without invoking loaders in async page export', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    const activeRuns = [createRunSummary({ id: 412, status: 'running' })];

    const root = (await Page({ activeRuns, authGate })) as ReactElement<{
      activeRuns: readonly DashboardRunSummary[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadDashboardRunsMock).not.toHaveBeenCalled();
    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(OverviewPageContent);
    expect(root.props.activeRuns).toEqual(activeRuns);
    expect(root.props.authGate).toEqual(authGate);
  });
});
