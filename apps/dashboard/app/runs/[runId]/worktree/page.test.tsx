// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';

const { NOT_FOUND_ERROR, notFoundMock, loadDashboardRunDetailMock } = vi.hoisted(() => {
  const error = new Error('NEXT_NOT_FOUND');

  return {
    NOT_FOUND_ERROR: error,
    notFoundMock: vi.fn(() => {
      throw error;
    }),
    loadDashboardRunDetailMock: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../../load-dashboard-runs', () => ({
  loadDashboardRunDetail: loadDashboardRunDetailMock,
}));

import RunWorktreePage from './page';

type RunDetailOverrides = Omit<Partial<DashboardRunDetail>, 'run'> & Readonly<{
  run?: Partial<DashboardRunDetail['run']>;
}>;

function createRunDetail(overrides: RunDetailOverrides = {}): DashboardRunDetail {
  return {
    run: {
      id: 2,
      tree: {
        id: 1,
        treeKey: 'test_flow',
        version: 1,
        name: 'test_flow',
      },
      repository: null,
      status: 'completed',
      startedAt: '2026-02-19T00:51:57.000Z',
      completedAt: '2026-02-19T00:51:57.000Z',
      createdAt: '2026-02-19T00:51:57.000Z',
      nodeSummary: {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      ...overrides.run,
    },
    nodes: overrides.nodes ?? [],
    artifacts: overrides.artifacts ?? [],
    routingDecisions: overrides.routingDecisions ?? [],
    worktrees: overrides.worktrees ?? [
      {
        id: 21,
        runId: 2,
        repositoryId: 1,
        path: '/tmp/worktrees/test-flow-2',
        branch: 'alphred/test_flow/2',
        commitHash: null,
        status: 'active',
        createdAt: '2026-02-19T00:51:57.000Z',
        removedAt: null,
      },
    ],
  };
}

describe('RunWorktreePage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    loadDashboardRunDetailMock.mockReset();
    loadDashboardRunDetailMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Run was not found.', { status: 404 }),
    );
  });

  it('renders changed files and default preview selection', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('heading', { name: 'Run #412 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'src/core/engine.ts *' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(412);
  });

  it('uses the deep-linked path when provided', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: 'apps/dashboard/app/runs/page.tsx' }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      '/runs/412">Open</Link>',
    );
  });

  it('falls back to the first tracked file when the requested path is unknown', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: 'does/not/exist.ts' }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(screen.getByRole('link', { name: 'View Diff' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });

  it('uses the first repeated path value before applying fallback rules', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({
          path: ['does/not/exist.ts', 'apps/dashboard/app/runs/page.tsx'],
        }),
      }),
    );

    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(screen.getByRole('link', { name: 'View Diff' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });

  it('renders empty state when the fixture run has no changed files', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '410' }) }));

    expect(screen.getByRole('heading', { name: 'No changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/410');
  });

  it('renders persisted run worktree metadata for non-fixture run ids', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(2);
    expect(screen.getByRole('heading', { name: 'Run #2 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Worktree metadata' })).toBeInTheDocument();
    expect(screen.getByText('/tmp/worktrees/test-flow-2')).toBeInTheDocument();
    expect(screen.getByText('alphred/test_flow/2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/2');
  });

  it('uses the newest removed worktree metadata when no active worktree exists', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        worktrees: [
          {
            id: 300,
            runId: 2,
            repositoryId: 1,
            path: '/tmp/worktrees/test-flow-2-old',
            branch: 'alphred/test_flow/2-old',
            commitHash: 'aaa111',
            status: 'removed',
            createdAt: '2026-02-19T00:00:00.000Z',
            removedAt: '2026-02-19T00:01:00.000Z',
          },
          {
            id: 301,
            runId: 2,
            repositoryId: 1,
            path: '/tmp/worktrees/test-flow-2-new',
            branch: 'alphred/test_flow/2-new',
            commitHash: 'bbb222',
            status: 'removed',
            createdAt: '2026-02-19T00:02:00.000Z',
            removedAt: '2026-02-19T00:03:00.000Z',
          },
        ],
      }),
    );

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(screen.getByText('/tmp/worktrees/test-flow-2-new')).toBeInTheDocument();
    expect(screen.getByText('alphred/test_flow/2-new')).toBeInTheDocument();
    expect(screen.queryByText('/tmp/worktrees/test-flow-2-old')).toBeNull();
  });

  it('prefers persisted run data over fixture content when ids collide', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        run: { id: 412 },
        worktrees: [
          {
            id: 220,
            runId: 412,
            repositoryId: 1,
            path: '/tmp/worktrees/persisted-412',
            branch: 'alphred/persisted/412',
            commitHash: 'abc1234',
            status: 'active',
            createdAt: '2026-02-19T00:51:57.000Z',
            removedAt: null,
          },
        ],
      }),
    );

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(412);
    expect(screen.getByRole('heading', { name: 'Worktree metadata' })).toBeInTheDocument();
    expect(screen.getByText('alphred/persisted/412')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Changed files' })).toBeNull();
  });

  it('routes missing persisted run ids to not-found', async () => {
    loadDashboardRunDetailMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Run was not found.', { status: 404 }),
    );

    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: '9999' }) }),
    ).rejects.toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('routes invalid run ids to not-found before loading persisted data', async () => {
    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: 'not-a-number' }) }),
    ).rejects.toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
    expect(loadDashboardRunDetailMock).not.toHaveBeenCalled();
  });
});
