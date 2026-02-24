import { describe, expect, it } from 'vitest';
import type { DashboardRunDetail, DashboardRunSummary, DashboardRunWorktreeMetadata } from '../../src/server/dashboard-contracts';
import {
  resolveRunWorktreePath,
  toRunDetailViewModel,
  toRunSummaryViewModel,
  toRunWorktreeViewModels,
} from './run-view-models';

function createRunSummary(overrides: Partial<DashboardRunSummary> = {}): DashboardRunSummary {
  return {
    id: overrides.id ?? 77,
    tree: {
      id: overrides.tree?.id ?? 3,
      treeKey: overrides.tree?.treeKey ?? 'demo-tree',
      version: overrides.tree?.version ?? 2,
      name: overrides.tree?.name ?? 'Demo Tree',
    },
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt === undefined ? '2026-02-17T20:01:00.000Z' : overrides.startedAt,
    completedAt: overrides.completedAt === undefined ? null : overrides.completedAt,
    createdAt: overrides.createdAt ?? '2026-02-17T20:00:00.000Z',
    nodeSummary: {
      pending: overrides.nodeSummary?.pending ?? 0,
      running: overrides.nodeSummary?.running ?? 1,
      completed: overrides.nodeSummary?.completed ?? 1,
      failed: overrides.nodeSummary?.failed ?? 0,
      skipped: overrides.nodeSummary?.skipped ?? 0,
      cancelled: overrides.nodeSummary?.cancelled ?? 0,
    },
  };
}

function createWorktrees(): DashboardRunWorktreeMetadata[] {
  return [
    {
      id: 1,
      runId: 77,
      repositoryId: 9,
      path: '/tmp/worktrees/demo-run-77',
      branch: 'alphred/demo-tree/77',
      commitHash: null,
      status: 'active',
      createdAt: '2026-02-17T20:02:00.000Z',
      removedAt: null,
    },
    {
      id: 2,
      runId: 77,
      repositoryId: 9,
      path: '/tmp/worktrees/demo-run-77-review',
      branch: 'alphred/demo-tree/77-review',
      commitHash: 'abc1234',
      status: 'removed',
      createdAt: '2026-02-17T20:03:00.000Z',
      removedAt: '2026-02-17T20:04:00.000Z',
    },
  ];
}

describe('run-view-models', () => {
  it('maps run summary contracts into UI labels with fallback values', () => {
    const viewModel = toRunSummaryViewModel(
      createRunSummary({
        status: 'cancelled',
        startedAt: null,
        completedAt: null,
        nodeSummary: {
          pending: 0,
          running: 1,
          completed: 1,
          failed: 0,
          skipped: 1,
          cancelled: 1,
        },
      }),
    );

    expect(viewModel.status).toBe('cancelled');
    expect(viewModel.workflowLabel).toBe('Demo Tree');
    expect(viewModel.workflowMetaLabel).toBe('demo-tree v2');
    expect(viewModel.startedAtLabel).toBe('Not started');
    expect(viewModel.completedAtLabel).toBe('In progress');
    expect(viewModel.nodeSummaryLabel).toContain('1 Running');
    expect(viewModel.nodeSummaryLabel).toContain('1 Skipped');
    expect(viewModel.nodeSummaryLabel).toContain('1 Cancelled');
  });

  it('maps run detail contracts into node, artifact, decision, and worktree models', () => {
    const detail: DashboardRunDetail = {
      run: createRunSummary(),
      nodes: [
        {
          id: 10,
          treeNodeId: 1,
          nodeKey: 'design',
          sequenceIndex: 0,
          attempt: 2,
          status: 'completed',
          startedAt: '2026-02-17T20:01:00.000Z',
          completedAt: '2026-02-17T20:02:00.000Z',
          latestArtifact: {
            id: 20,
            runNodeId: 10,
            artifactType: 'report',
            contentType: 'markdown',
            contentPreview: 'Design report',
            createdAt: '2026-02-17T20:02:01.000Z',
          },
          latestRoutingDecision: {
            id: 30,
            runNodeId: 10,
            decisionType: 'changes_requested',
            rationale: 'Need more tests',
            createdAt: '2026-02-17T20:02:02.000Z',
          },
        },
        {
          id: 11,
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
      artifacts: [
        {
          id: 21,
          runNodeId: 10,
          artifactType: 'report',
          contentType: 'markdown',
          contentPreview: 'Latest report preview',
          createdAt: '2026-02-17T20:02:03.000Z',
        },
      ],
      routingDecisions: [
        {
          id: 31,
          runNodeId: 10,
          decisionType: 'changes_requested',
          rationale: 'Needs update',
          createdAt: '2026-02-17T20:02:04.000Z',
        },
      ],
      worktrees: createWorktrees(),
    };

    const viewModel = toRunDetailViewModel(detail);

    expect(viewModel.nodes[0]?.attemptLabel).toBe('Attempt 2');
    expect(viewModel.nodes[0]?.latestArtifactLabel).toBe('Report (Markdown)');
    expect(viewModel.nodes[0]?.latestRoutingDecisionLabel).toBe('Changes Requested');
    expect(viewModel.nodes[1]?.status).toBe('skipped');
    expect(viewModel.artifacts[0]?.artifactLabel).toBe('Report (Markdown)');
    expect(viewModel.routingDecisions[0]?.decisionLabel).toBe('Changes Requested');
    expect(viewModel.worktrees[0]?.commitHashLabel).toBe('No commit hash recorded');
    expect(viewModel.worktrees[0]?.removedAtLabel).toBe('Active');
  });

  it('resolves worktree selection using first-query-value and fallback behavior', () => {
    const worktrees = toRunWorktreeViewModels(createWorktrees());

    expect(resolveRunWorktreePath(worktrees, undefined)).toBe('/tmp/worktrees/demo-run-77');
    expect(resolveRunWorktreePath(worktrees, ['/tmp/worktrees/demo-run-77-review', '/tmp/worktrees/demo-run-77'])).toBe(
      '/tmp/worktrees/demo-run-77-review',
    );
    expect(resolveRunWorktreePath(worktrees, ['does/not/exist', '/tmp/worktrees/demo-run-77-review'])).toBe(
      '/tmp/worktrees/demo-run-77',
    );
  });
});
