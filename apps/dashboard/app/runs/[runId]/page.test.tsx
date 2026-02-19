// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardRunDetail } from '../../../src/server/dashboard-contracts';

const { NOT_FOUND_ERROR, notFoundMock, loadDashboardRunDetailMock, loadDashboardRepositoriesMock } = vi.hoisted(() => {
  const error = new Error('NEXT_NOT_FOUND');

  return {
    NOT_FOUND_ERROR: error,
    notFoundMock: vi.fn(() => {
      throw error;
    }),
    loadDashboardRunDetailMock: vi.fn(),
    loadDashboardRepositoriesMock: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('../load-dashboard-runs', () => ({
  loadDashboardRunDetail: loadDashboardRunDetailMock,
}));

vi.mock('../../repositories/load-dashboard-repositories', () => ({
  loadDashboardRepositories: loadDashboardRepositoriesMock,
}));

import RunDetailPage from './page';

function createRepository(overrides: Partial<DashboardRepositoryState> = {}): DashboardRepositoryState {
  const name = overrides.name ?? 'demo-repo';

  return {
    id: overrides.id ?? 1,
    name,
    provider: overrides.provider ?? 'github',
    remoteRef: overrides.remoteRef ?? `octocat/${name}`,
    remoteUrl: overrides.remoteUrl ?? `https://github.com/octocat/${name}.git`,
    defaultBranch: overrides.defaultBranch ?? 'main',
    branchTemplate: overrides.branchTemplate ?? null,
    cloneStatus: overrides.cloneStatus ?? 'cloned',
    localPath: overrides.localPath ?? `/tmp/repos/${name}`,
  };
}

type RunDetailOverrides = Omit<Partial<DashboardRunDetail>, 'run'> & Readonly<{
  run?: Partial<DashboardRunDetail['run']>;
}>;

function createRunDetail(overrides: RunDetailOverrides = {}): DashboardRunDetail {
  return {
    run: {
      id: 412,
      tree: {
        id: 1,
        treeKey: 'demo-tree',
        version: 1,
        name: 'Demo Tree',
      },
      repository: {
        id: 1,
        name: 'demo-repo',
      },
      status: 'running',
      startedAt: '2026-02-18T00:00:00.000Z',
      completedAt: null,
      createdAt: '2026-02-18T00:00:00.000Z',
      nodeSummary: {
        pending: 0,
        running: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      ...overrides.run,
    },
    nodes: overrides.nodes ?? [
      {
        id: 1,
        treeNodeId: 1,
        nodeKey: 'design',
        sequenceIndex: 0,
        attempt: 1,
        status: 'completed',
        startedAt: '2026-02-18T00:00:10.000Z',
        completedAt: '2026-02-18T00:00:30.000Z',
        latestArtifact: null,
        latestRoutingDecision: null,
      },
      {
        id: 2,
        treeNodeId: 2,
        nodeKey: 'implement',
        sequenceIndex: 1,
        attempt: 1,
        status: 'running',
        startedAt: '2026-02-18T00:00:35.000Z',
        completedAt: null,
        latestArtifact: null,
        latestRoutingDecision: null,
      },
    ],
    artifacts: overrides.artifacts ?? [
      {
        id: 1,
        runNodeId: 1,
        artifactType: 'report',
        contentType: 'markdown',
        contentPreview: 'Plan complete and ready for operator review.',
        createdAt: '2026-02-18T00:00:25.000Z',
      },
    ],
    routingDecisions: overrides.routingDecisions ?? [
      {
        id: 1,
        runNodeId: 1,
        decisionType: 'approved',
        rationale: 'All checks passed.',
        createdAt: '2026-02-18T00:00:31.000Z',
      },
    ],
    worktrees: overrides.worktrees ?? [
      {
        id: 5,
        runId: 412,
        repositoryId: 1,
        path: '/tmp/worktrees/demo-tree-412',
        branch: 'alphred/demo-tree/412',
        commitHash: null,
        status: 'active',
        createdAt: '2026-02-18T00:00:08.000Z',
        removedAt: null,
      },
    ],
  };
}

describe('RunDetailPage', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    loadDashboardRunDetailMock.mockReset();
    loadDashboardRepositoriesMock.mockReset();
  });

  it('renders persisted run detail and terminal action link when completed run has worktree', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        run: {
          id: 410,
          status: 'completed',
          completedAt: '2026-02-18T00:04:00.000Z',
        },
        worktrees: [
          {
            id: 2,
            runId: 410,
            repositoryId: 1,
            path: '/tmp/worktrees/demo-tree-410',
            branch: 'alphred/demo-tree/410',
            commitHash: null,
            status: 'active',
            createdAt: '2026-02-18T00:00:00.000Z',
            removedAt: null,
          },
        ],
      }),
    );
    loadDashboardRepositoriesMock.mockResolvedValue([createRepository({ id: 1, name: 'demo-repo' })]);

    render(await RunDetailPage({ params: Promise.resolve({ runId: '410' }) }));

    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith(410);
    expect(screen.getByRole('heading', { name: 'Run #410' })).toBeInTheDocument();
    expect(screen.getByText('demo-repo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Worktree' })).toHaveAttribute('href', '/runs/410/worktree');
  });

  it('blocks invalid actions for running runs with explicit feedback', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());
    loadDashboardRepositoriesMock.mockResolvedValue([createRepository({ id: 1, name: 'demo-repo' })]);

    render(await RunDetailPage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(
      screen.getByText('Pause action is blocked until lifecycle controls are available.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Run timeline')).toBeInTheDocument();
    expect(screen.getByText('Routing decision: approved.')).toBeInTheDocument();
  });

  it('uses the newest removed worktree for repository context when no active worktree exists', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        worktrees: [
          {
            id: 100,
            runId: 412,
            repositoryId: 7,
            path: '/tmp/worktrees/demo-tree-412-old',
            branch: 'alphred/demo-tree/412-old',
            commitHash: null,
            status: 'removed',
            createdAt: '2026-02-18T00:00:00.000Z',
            removedAt: '2026-02-18T00:01:00.000Z',
          },
          {
            id: 101,
            runId: 412,
            repositoryId: 8,
            path: '/tmp/worktrees/demo-tree-412-new',
            branch: 'alphred/demo-tree/412-new',
            commitHash: null,
            status: 'removed',
            createdAt: '2026-02-18T00:02:00.000Z',
            removedAt: '2026-02-18T00:03:00.000Z',
          },
        ],
      }),
    );
    loadDashboardRepositoriesMock.mockResolvedValue([
      createRepository({ id: 7, name: 'old-repo' }),
      createRepository({ id: 8, name: 'new-repo' }),
    ]);

    render(await RunDetailPage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByText('new-repo')).toBeInTheDocument();
    expect(screen.queryByText('old-repo')).toBeNull();
  });

  it('does not render a synthetic start event when run has not started', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        run: {
          id: 413,
          status: 'pending',
          startedAt: null,
          completedAt: null,
        },
        nodes: [],
        artifacts: [],
        routingDecisions: [],
        worktrees: [],
      }),
    );
    loadDashboardRepositoriesMock.mockResolvedValue([createRepository({ id: 1, name: 'demo-repo' })]);

    render(await RunDetailPage({ params: Promise.resolve({ runId: '413' }) }));

    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.queryByText('Run started.')).toBeNull();
    expect(screen.getByText('No lifecycle events captured yet.')).toBeInTheDocument();
  });

  it('routes invalid run ids to not-found', async () => {
    await expect(RunDetailPage({ params: Promise.resolve({ runId: 'not-a-number' }) })).rejects.toThrow(
      NOT_FOUND_ERROR,
    );
    expect(notFoundMock).toHaveBeenCalled();
    expect(loadDashboardRunDetailMock).not.toHaveBeenCalled();
  });
});
