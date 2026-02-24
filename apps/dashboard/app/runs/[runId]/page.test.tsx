// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRunDetail } from '../../../src/server/dashboard-contracts';

const { loadDashboardRunDetailMock } = vi.hoisted(() => ({
  loadDashboardRunDetailMock: vi.fn(),
}));

vi.mock('./load-dashboard-run-detail', () => ({
  loadDashboardRunDetail: loadDashboardRunDetailMock,
}));

import RunDetailPage from './page';

function createRunDetail(overrides: Partial<DashboardRunDetail> = {}): DashboardRunDetail {
  const runId = overrides.run?.id ?? 410;

  return {
    run: {
      id: runId,
      tree: {
        id: overrides.run?.tree?.id ?? 14,
        treeKey: overrides.run?.tree?.treeKey ?? 'demo-tree',
        version: overrides.run?.tree?.version ?? 1,
        name: overrides.run?.tree?.name ?? 'Demo Tree',
      },
      status: overrides.run?.status ?? 'completed',
      startedAt: overrides.run?.startedAt === undefined ? '2026-02-17T20:01:00.000Z' : overrides.run.startedAt,
      completedAt: overrides.run?.completedAt === undefined ? '2026-02-17T20:04:00.000Z' : overrides.run.completedAt,
      createdAt: overrides.run?.createdAt ?? '2026-02-17T20:00:00.000Z',
      nodeSummary: {
        pending: overrides.run?.nodeSummary?.pending ?? 0,
        running: overrides.run?.nodeSummary?.running ?? 0,
        completed: overrides.run?.nodeSummary?.completed ?? 1,
        failed: overrides.run?.nodeSummary?.failed ?? 0,
        skipped: overrides.run?.nodeSummary?.skipped ?? 0,
        cancelled: overrides.run?.nodeSummary?.cancelled ?? 0,
      },
    },
    nodes: overrides.nodes ?? [
      {
        id: 1,
        treeNodeId: 1,
        nodeKey: 'design',
        sequenceIndex: 0,
        attempt: 1,
        status: 'completed',
        startedAt: '2026-02-17T20:01:00.000Z',
        completedAt: '2026-02-17T20:02:00.000Z',
        latestArtifact: null,
        latestRoutingDecision: null,
      },
    ],
    artifacts: overrides.artifacts ?? [
      {
        id: 11,
        runNodeId: 1,
        artifactType: 'report',
        contentType: 'markdown',
        contentPreview: 'Implementation complete.',
        createdAt: '2026-02-17T20:03:00.000Z',
      },
    ],
    routingDecisions: overrides.routingDecisions ?? [
      {
        id: 13,
        runNodeId: 1,
        decisionType: 'approved',
        rationale: 'Quality checks passed.',
        createdAt: '2026-02-17T20:04:00.000Z',
      },
    ],
    worktrees: overrides.worktrees ?? [
      {
        id: 21,
        runId,
        repositoryId: 3,
        path: 'tmp/worktrees/demo-run-410',
        branch: 'alphred/demo-tree/410',
        commitHash: 'abc1234',
        status: 'active',
        createdAt: '2026-02-17T20:01:30.000Z',
        removedAt: null,
      },
    ],
  };
}

describe('RunDetailPage', () => {
  beforeEach(() => {
    loadDashboardRunDetailMock.mockReset();
  });

  it('renders run summary and completed-run worktree action', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(createRunDetail());

    render(await RunDetailPage({ params: Promise.resolve({ runId: '410' }) }));

    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith('410');
    expect(screen.getByRole('heading', { name: 'Run #410' })).toBeInTheDocument();
    expect(screen.getByText('Demo Tree')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Worktree' })).toHaveAttribute(
      'href',
      '/runs/410/worktree?path=tmp%2Fworktrees%2Fdemo-run-410',
    );
  });

  it('renders status-specific primary action for cancelled runs', async () => {
    loadDashboardRunDetailMock.mockResolvedValue(
      createRunDetail({
        run: {
          id: 412,
          tree: {
            id: 14,
            treeKey: 'demo-tree',
            version: 1,
            name: 'Demo Tree',
          },
          status: 'cancelled',
          startedAt: '2026-02-17T20:01:00.000Z',
          completedAt: '2026-02-17T20:03:00.000Z',
          createdAt: '2026-02-17T20:00:00.000Z',
          nodeSummary: {
            pending: 0,
            running: 0,
            completed: 1,
            failed: 0,
            skipped: 1,
            cancelled: 1,
          },
        },
        nodes: [
          {
            id: 1,
            treeNodeId: 1,
            nodeKey: 'design',
            sequenceIndex: 0,
            attempt: 1,
            status: 'completed',
            startedAt: '2026-02-17T20:01:00.000Z',
            completedAt: '2026-02-17T20:02:00.000Z',
            latestArtifact: null,
            latestRoutingDecision: null,
          },
          {
            id: 2,
            treeNodeId: 2,
            nodeKey: 'review',
            sequenceIndex: 1,
            attempt: 1,
            status: 'skipped',
            startedAt: null,
            completedAt: null,
            latestArtifact: null,
            latestRoutingDecision: null,
          },
        ],
        worktrees: [],
      }),
    );

    render(await RunDetailPage({ params: Promise.resolve({ runId: '412' }) }));

    expect(screen.getByRole('button', { name: 'Run Cancelled' })).toBeDisabled();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('propagates not-found loader errors', async () => {
    const notFoundError = new Error('NEXT_NOT_FOUND');
    loadDashboardRunDetailMock.mockRejectedValue(notFoundError);

    await expect(RunDetailPage({ params: Promise.resolve({ runId: '9999' }) })).rejects.toThrow(
      notFoundError,
    );
    expect(loadDashboardRunDetailMock).toHaveBeenCalledWith('9999');
  });
});
