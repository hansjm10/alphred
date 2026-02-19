// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardRunDetail } from '../../../src/server/dashboard-contracts';
import { RunDetailContent } from './run-detail-content';

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

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

describe('RunDetailContent realtime updates', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes active run detail without a full page reload', async () => {
    const updated = createRunDetail({
      run: {
        status: 'paused',
      },
    });
    fetchMock.mockImplementation(() => Promise.resolve(createJsonResponse(updated)));

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/dashboard/runs/412',
        expect.objectContaining({ method: 'GET' }),
      );
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    }, { timeout: 2_000 });

    expect(screen.getByText(/Live updates every 1s/)).toBeInTheDocument();
  });

  it('shows reconnect state after transient failure and recovers on retry', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(() => Promise.resolve(createJsonResponse(createRunDetail())));

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        pollIntervalMs={50}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Connection interrupted\. Retrying in/i)).toBeInTheDocument();
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByText(/Live updates every 1s/)).toBeInTheDocument();
    }, { timeout: 2_000 });
  });

  it('filters timeline events when selecting a node from the status panel', async () => {
    const user = userEvent.setup();

    render(
      <RunDetailContent
        initialDetail={createRunDetail()}
        repositories={[createRepository()]}
        enableRealtime={false}
      />,
    );

    expect(screen.getByText('implement started (attempt 1).')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'design (attempt 1)' }));

    expect(screen.getByText('design completed.')).toBeInTheDocument();
    expect(screen.queryByText('implement started (attempt 1).')).toBeNull();
  });
});
