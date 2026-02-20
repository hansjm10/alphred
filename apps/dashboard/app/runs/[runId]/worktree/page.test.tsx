// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import type { PersistedRunWorktreeExplorer } from './load-persisted-worktree-explorer';

const {
  NOT_FOUND_ERROR,
  notFoundMock,
  loadDashboardRunDetailMock,
  loadPersistedRunWorktreeExplorerMock,
} = vi.hoisted(() => {
  const error = new Error('NEXT_NOT_FOUND');

  return {
    NOT_FOUND_ERROR: error,
    notFoundMock: vi.fn(() => {
      throw error;
    }),
    loadDashboardRunDetailMock: vi.fn(),
    loadPersistedRunWorktreeExplorerMock: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../../load-dashboard-runs', () => ({
  loadDashboardRunDetail: loadDashboardRunDetailMock,
}));

vi.mock('./load-persisted-worktree-explorer', () => ({
  loadPersistedRunWorktreeExplorer: loadPersistedRunWorktreeExplorerMock,
}));

import RunWorktreePage from './page';

type RunDetailOverrides = Omit<Partial<DashboardRunDetail>, 'run'> & Readonly<{
  run?: Partial<DashboardRunDetail['run']>;
}>;

type PersistedExplorerOverrides = Partial<PersistedRunWorktreeExplorer>;

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

function createPersistedExplorer(
  overrides: PersistedExplorerOverrides = {},
): PersistedRunWorktreeExplorer {
  return {
    files: overrides.files ?? [
      { path: 'src/core/engine.ts', changed: true },
      { path: 'README.md', changed: false },
    ],
    changedFileCount: overrides.changedFileCount ?? 1,
    selectedPath: overrides.selectedPath ?? 'src/core/engine.ts',
    preview: overrides.preview ?? {
      path: 'src/core/engine.ts',
      changed: true,
      diff: 'diff --git a/src/core/engine.ts b/src/core/engine.ts\n+ emitLifecycleCheckpoint(runId)',
      diffMessage: null,
      content: 'export function emitLifecycleCheckpoint(runId: number) {\n  return runId;\n}',
      contentMessage: null,
      binary: false,
    },
    previewError: overrides.previewError ?? null,
  };
}

describe('RunWorktreePage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    loadDashboardRunDetailMock.mockReset();
    loadDashboardRunDetailMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Run was not found.', { status: 404 }),
    );

    loadPersistedRunWorktreeExplorerMock.mockReset();
    loadPersistedRunWorktreeExplorerMock.mockResolvedValue(createPersistedExplorer());
  });

  it('renders changed files and default preview selection for fixture-backed runs', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('heading', { name: 'Run #412 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open src/core/engine.ts preview' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
    expect(screen.getByLabelText('File diff preview')).toHaveTextContent(
      'emitLifecycleCheckpoint',
    );
    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(412);
    expect(loadPersistedRunWorktreeExplorerMock).not.toHaveBeenCalled();
  });

  it('uses the deep-linked path when provided for fixture-backed runs', async () => {
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

  it('falls back to the first changed file when the requested path is unknown', async () => {
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
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts&view=diff',
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
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts&view=diff',
    );
  });

  it('renders content preview mode when requested', async () => {
    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({
          path: 'apps/dashboard/app/runs/page.tsx',
          view: 'content',
        }),
      }),
    );

    expect(screen.getByLabelText('File content preview')).toHaveTextContent(
      'Runs table now links to canonical run detail routes.',
    );
    expect(screen.queryByLabelText('File diff preview')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open src/core/engine.ts preview' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts&view=content',
    );
  });

  it('renders empty state when fixture run has no changed files', async () => {
    render(await RunWorktreePage({ params: Promise.resolve({ runId: '410' }) }));

    expect(screen.getByRole('heading', { name: 'No changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/410');
  });

  it('renders persisted run worktree explorer for non-fixture runs', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(2);
    expect(loadPersistedRunWorktreeExplorerMock).toHaveBeenCalledWith('/tmp/worktrees/test-flow-2', undefined);
    expect(screen.getByRole('heading', { name: 'Run #2 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open src/core/engine.ts preview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Worktree metadata' })).toBeNull();
  });

  it('uses newest removed worktree metadata when no active worktree exists', async () => {
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

    expect(loadPersistedRunWorktreeExplorerMock).toHaveBeenCalledWith('/tmp/worktrees/test-flow-2-new', undefined);
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
    expect(loadPersistedRunWorktreeExplorerMock).toHaveBeenCalledWith('/tmp/worktrees/persisted-412', undefined);
    expect(screen.getByRole('heading', { name: 'Changed files' })).toBeInTheDocument();
  });

  it('renders persisted tracked-file explorer when changed-file count is zero', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());
    loadPersistedRunWorktreeExplorerMock.mockResolvedValue(
      createPersistedExplorer({
        files: [{ path: 'README.md', changed: false }],
        changedFileCount: 0,
        selectedPath: 'README.md',
        preview: {
          path: 'README.md',
          changed: false,
          diff: null,
          diffMessage: 'No diff available because this file is unchanged in this worktree snapshot.',
          content: '# Alphred\n',
          contentMessage: null,
          binary: false,
        },
      }),
    );

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(screen.getByRole('heading', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open README.md preview' })).toHaveAttribute(
      'href',
      '/runs/2/worktree?path=README.md',
    );
    expect(screen.queryByRole('heading', { name: 'No changed files' })).toBeNull();
  });

  it('renders persisted no-worktree state when run metadata has no captured worktree', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        run: { id: 2 },
        worktrees: [],
      }),
    );

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(screen.getByRole('heading', { name: 'No changed files' })).toBeInTheDocument();
    expect(screen.getByText('This run does not have a captured worktree.')).toBeInTheDocument();
    expect(loadPersistedRunWorktreeExplorerMock).not.toHaveBeenCalled();
  });

  it('renders path-scoped retry state when persisted explorer loader fails', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());
    loadPersistedRunWorktreeExplorerMock.mockRejectedValue(new Error('worktree load failed'));

    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '2' }),
        searchParams: Promise.resolve({ path: 'src/core/engine.ts' }),
      }),
    );

    expect(screen.getByRole('heading', { name: 'Unable to load worktree files' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retry Path' })).toHaveAttribute(
      'href',
      '/runs/2/worktree?path=src%2Fcore%2Fengine.ts&view=diff',
    );
  });

  it('renders path-scoped preview retry state when preview retrieval fails', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());
    loadPersistedRunWorktreeExplorerMock.mockResolvedValue(
      createPersistedExplorer({
        selectedPath: 'src/core/engine.ts',
        preview: null,
        previewError: 'Unable to load preview data for the selected path. Retry this path or choose another file.',
      }),
    );

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }));

    expect(
      screen.getByText('Unable to load preview data for the selected path. Retry this path or choose another file.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retry Path' })).toHaveAttribute(
      'href',
      '/runs/2/worktree?path=src%2Fcore%2Fengine.ts&view=diff',
    );
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

  it('rethrows unexpected persisted run loader failures', async () => {
    const failure = new Error('Service unavailable');
    loadDashboardRunDetailMock.mockRejectedValue(failure);

    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: '2' }) }),
    ).rejects.toThrow(failure);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('routes invalid run ids to not-found before loading persisted data', async () => {
    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: 'not-a-number' }) }),
    ).rejects.toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
    expect(loadDashboardRunDetailMock).not.toHaveBeenCalled();
  });
});
