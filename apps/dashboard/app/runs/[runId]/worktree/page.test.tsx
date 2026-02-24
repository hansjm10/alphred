// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRunWorktreeLoadResult } from './load-dashboard-run-worktrees';

const { loadDashboardRunWorktreesMock } = vi.hoisted(() => ({
  loadDashboardRunWorktreesMock: vi.fn(),
}));

vi.mock('./load-dashboard-run-worktrees', () => ({
  loadDashboardRunWorktrees: loadDashboardRunWorktreesMock,
}));

import RunWorktreePage from './page';

function createLoadResult(overrides: Partial<DashboardRunWorktreeLoadResult> = {}): DashboardRunWorktreeLoadResult {
  return {
    run: overrides.run ?? {
      id: 412,
      tree: {
        id: 14,
        treeKey: 'demo-tree',
        version: 1,
        name: 'Demo Tree',
      },
      status: 'running',
      startedAt: '2026-02-17T20:01:00.000Z',
      completedAt: null,
      createdAt: '2026-02-17T20:00:00.000Z',
      nodeSummary: {
        pending: 0,
        running: 1,
        completed: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
    },
    worktrees: overrides.worktrees ?? [
      {
        id: 21,
        runId: 412,
        repositoryId: 3,
        path: '/tmp/worktrees/demo-run-412',
        branch: 'alphred/demo-tree/412',
        commitHash: 'abc1234',
        status: 'active',
        createdAt: '2026-02-17T20:01:30.000Z',
        removedAt: null,
      },
      {
        id: 22,
        runId: 412,
        repositoryId: 3,
        path: '/tmp/worktrees/demo-run-412-review',
        branch: 'alphred/demo-tree/412-review',
        commitHash: null,
        status: 'removed',
        createdAt: '2026-02-17T20:02:30.000Z',
        removedAt: '2026-02-17T20:05:00.000Z',
      },
    ],
  };
}

describe('RunWorktreePage', () => {
  beforeEach(() => {
    loadDashboardRunWorktreesMock.mockReset();
  });

  it('renders persisted worktree metadata and default selection', async () => {
    loadDashboardRunWorktreesMock.mockResolvedValue(createLoadResult());

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(loadDashboardRunWorktreesMock).toHaveBeenCalledWith('412');
    expect(screen.getByRole('heading', { name: 'Run #412 worktree' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '/tmp/worktrees/demo-run-412' })).toHaveAttribute(
      'href',
      '/runs/412/worktree?path=%2Ftmp%2Fworktrees%2Fdemo-run-412',
    );
    expect(screen.getByText('Persisted metadata for the selected worktree')).toBeInTheDocument();
    expect(screen.getByText('File-level diffs are not available in the current backend contract. This view currently shows persisted worktree metadata only.')).toBeInTheDocument();
  });

  it('uses the deep-linked path when provided', async () => {
    loadDashboardRunWorktreesMock.mockResolvedValue(createLoadResult());

    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: '/tmp/worktrees/demo-run-412-review' }),
      }),
    );

    expect(screen.getByRole('link', { name: '/tmp/worktrees/demo-run-412-review' })).toHaveClass(
      'button-link--primary',
    );
    expect(screen.getByText('removed')).toBeInTheDocument();
  });

  it('falls back to the first tracked worktree when the requested path is unknown', async () => {
    loadDashboardRunWorktreesMock.mockResolvedValue(createLoadResult());

    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({ path: 'does/not/exist' }),
      }),
    );

    expect(screen.getByRole('link', { name: '/tmp/worktrees/demo-run-412' })).toHaveClass(
      'button-link--primary',
    );
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('uses the first repeated path value before applying fallback rules', async () => {
    loadDashboardRunWorktreesMock.mockResolvedValue(createLoadResult());

    render(
      await RunWorktreePage({
        params: Promise.resolve({ runId: '412' }),
        searchParams: Promise.resolve({
          path: ['does/not/exist', '/tmp/worktrees/demo-run-412-review'],
        }),
      }),
    );

    expect(screen.getByRole('link', { name: '/tmp/worktrees/demo-run-412' })).toHaveClass(
      'button-link--primary',
    );
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('renders metadata-first empty state when no worktrees are recorded', async () => {
    loadDashboardRunWorktreesMock.mockResolvedValue(createLoadResult({ worktrees: [] }));

    render(await RunWorktreePage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('heading', { name: 'No worktree metadata' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Run' })).toHaveAttribute('href', '/runs/412');
  });

  it('propagates not-found loader errors', async () => {
    const notFoundError = new Error('NEXT_NOT_FOUND');
    loadDashboardRunWorktreesMock.mockRejectedValue(notFoundError);

    await expect(
      RunWorktreePage({ params: Promise.resolve({ runId: '9999' }) }),
    ).rejects.toThrow(notFoundError);
    expect(loadDashboardRunWorktreesMock).toHaveBeenCalledWith('9999');
  });
});
