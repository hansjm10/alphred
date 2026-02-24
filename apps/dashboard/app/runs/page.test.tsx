// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';
import RunsPage, { RunsPageContent } from './page';

const { loadDashboardRunsMock } = vi.hoisted(() => ({
  loadDashboardRunsMock: vi.fn(),
}));

vi.mock('./load-dashboard-runs', () => ({
  loadDashboardRuns: loadDashboardRunsMock,
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

describe('RunsPage', () => {
  const runs: readonly DashboardRunSummary[] = [
    createRunSummary({ id: 412, status: 'running', tree: { id: 14, treeKey: 'demo-tree', version: 1, name: 'Demo Tree' } }),
    createRunSummary({ id: 411, status: 'failed', tree: { id: 14, treeKey: 'demo-tree', version: 1, name: 'Demo Tree' } }),
    createRunSummary({ id: 410, status: 'completed', tree: { id: 14, treeKey: 'demo-tree', version: 1, name: 'Demo Tree' } }),
  ];

  beforeEach(() => {
    loadDashboardRunsMock.mockReset();
  });

  it('renders run status tabs and lifecycle rows', () => {
    render(<RunsPageContent runs={runs} />);

    expect(screen.getByRole('heading', { name: 'Run lifecycle' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Run status filters' })).toBeInTheDocument();
    expect(screen.getByText('#412 Demo Tree')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })[0]).toHaveAttribute('href', '/runs/412');
    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute(
      'href',
      '/runs?status=running',
    );
    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks the running tab as current when status filter is running', () => {
    render(<RunsPageContent runs={runs} searchParams={{ status: 'running' }} />);

    expect(screen.getByRole('link', { name: 'Running' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'All Runs' })).not.toHaveAttribute('aria-current');
  });

  it('marks the failed tab as current when status filter is failed', () => {
    render(<RunsPageContent runs={runs} searchParams={{ status: 'failed' }} />);

    expect(screen.getByRole('link', { name: 'Failed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'All Runs' })).not.toHaveAttribute('aria-current');
  });

  it('uses the first status value when repeated query values are provided', () => {
    render(<RunsPageContent runs={runs} searchParams={{ status: ['failed', 'running'] }} />);

    expect(screen.getByRole('link', { name: 'Failed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('#412 Demo Tree')).not.toBeInTheDocument();
    expect(screen.getByText('#411 Demo Tree')).toBeInTheDocument();
  });

  it('falls back to all runs when the first repeated status value is unsupported', () => {
    render(<RunsPageContent runs={runs} searchParams={{ status: ['paused', 'running'] }} />);

    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('#412 Demo Tree')).toBeInTheDocument();
    expect(screen.getByText('#411 Demo Tree')).toBeInTheDocument();
  });

  it('falls back to all runs tab for unknown status filters', () => {
    render(<RunsPageContent runs={runs} searchParams={{ status: 'paused' }} />);

    expect(screen.getByRole('link', { name: 'All Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Running' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Failed' })).not.toHaveAttribute('aria-current');
  });

  it('loads run summaries in async export when runs prop is omitted', async () => {
    loadDashboardRunsMock.mockResolvedValue(runs);

    const root = (await RunsPage()) as ReactElement<{
      runs: readonly DashboardRunSummary[];
      searchParams: { status?: string | string[] } | undefined;
    }>;

    expect(loadDashboardRunsMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(RunsPageContent);
    expect(root.props.runs).toEqual(runs);
    expect(root.props.searchParams).toBeUndefined();
  });

  it('uses provided runs without invoking loader in async export', async () => {
    const root = (await RunsPage({ runs })) as ReactElement<{
      runs: readonly DashboardRunSummary[];
      searchParams: { status?: string | string[] } | undefined;
    }>;

    expect(loadDashboardRunsMock).not.toHaveBeenCalled();
    expect(root.type).toBe(RunsPageContent);
    expect(root.props.runs).toEqual(runs);
  });
});
