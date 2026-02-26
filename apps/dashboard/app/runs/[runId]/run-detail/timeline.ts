import type { DashboardRunDetail, DashboardRepositoryState } from '../../../../src/server/dashboard-contracts';
import { parseDateValue, toNodeTerminalSummary } from './formatting';
import type { RecentPartition, RecentPartitionOrder, TimelineCategory, TimelineItem } from './types';

export function partitionByRecency<T>(
  items: readonly T[],
  recentCount: number,
  order: RecentPartitionOrder = 'oldest-first',
): RecentPartition<T> {
  if (recentCount <= 0 || items.length <= recentCount) {
    return {
      recent: [...items],
      earlier: [],
    };
  }

  if (order === 'newest-first') {
    return {
      recent: items.slice(0, recentCount),
      earlier: items.slice(recentCount),
    };
  }

  const splitIndex = items.length - recentCount;
  return {
    recent: items.slice(splitIndex),
    earlier: items.slice(0, splitIndex),
  };
}

export const TIMELINE_CATEGORY_LABELS: Record<TimelineCategory, string> = {
  lifecycle: 'Lifecycle',
  node: 'Node',
  artifact: 'Artifact',
  diagnostics: 'Diagnostics',
  routing: 'Routing',
};


export function buildTimeline(detail: DashboardRunDetail): readonly TimelineItem[] {
  const fallbackDate = parseDateValue(detail.run.createdAt) ?? new Date(0);
  const events: TimelineItem[] = [];

  const startedAt = parseDateValue(detail.run.startedAt);
  if (startedAt) {
    events.push({
      key: `run-start-${detail.run.id}`,
      timestamp: startedAt,
      summary: 'Run started.',
      relatedNodeId: null,
      category: 'lifecycle',
    });
  }

  const completedAt = parseDateValue(detail.run.completedAt);
  if (completedAt) {
    events.push({
      key: `run-terminal-${detail.run.id}`,
      timestamp: completedAt,
      summary: `Run reached terminal state (${detail.run.status}).`,
      relatedNodeId: null,
      category: 'lifecycle',
    });
  }

  for (const node of detail.nodes) {
    const nodeStartedAt = parseDateValue(node.startedAt);
    if (nodeStartedAt) {
      events.push({
        key: `node-start-${node.id}`,
        timestamp: nodeStartedAt,
        summary: `${node.nodeKey} started (attempt ${node.attempt}).`,
        relatedNodeId: node.id,
        category: 'node',
      });
    }

    const nodeCompletedAt = parseDateValue(node.completedAt);
    if (nodeCompletedAt) {
      events.push({
        key: `node-terminal-${node.id}`,
        timestamp: nodeCompletedAt,
        summary: toNodeTerminalSummary(node),
        relatedNodeId: node.id,
        category: 'node',
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const createdAt = parseDateValue(artifact.createdAt) ?? fallbackDate;
    events.push({
      key: `artifact-${artifact.id}`,
      timestamp: createdAt,
      summary: `Artifact captured (${artifact.artifactType}/${artifact.contentType}).`,
      relatedNodeId: artifact.runNodeId,
      category: 'artifact',
    });
  }

  for (const decision of detail.routingDecisions) {
    const createdAt = parseDateValue(decision.createdAt) ?? fallbackDate;
    events.push({
      key: `decision-${decision.id}`,
      timestamp: createdAt,
      summary: `Routing decision: ${decision.decisionType}.`,
      relatedNodeId: decision.runNodeId,
      category: 'routing',
    });
  }

  for (const diagnostics of detail.diagnostics) {
    const createdAt = parseDateValue(diagnostics.createdAt) ?? fallbackDate;
    events.push({
      key: `diagnostics-${diagnostics.id}`,
      timestamp: createdAt,
      summary: `Diagnostics persisted (attempt ${diagnostics.attempt}, ${diagnostics.outcome}).`,
      relatedNodeId: diagnostics.runNodeId,
      category: 'diagnostics',
    });
  }

  return events.sort((left, right) => {
    const timeDifference = left.timestamp.getTime() - right.timestamp.getTime();
    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.key.localeCompare(right.key);
  });
}

export function resolveRepositoryContext(
  detail: DashboardRunDetail,
  repositories: readonly DashboardRepositoryState[],
): string {
  if (detail.worktrees.length === 0) {
    return 'Not attached';
  }

  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]));
  const repositoryContextWorktree =
    detail.worktrees.find((worktree) => worktree.status === 'active') ??
    detail.worktrees.at(-1);
  if (!repositoryContextWorktree) {
    return 'Not attached';
  }

  return (
    repositoryNameById.get(repositoryContextWorktree.repositoryId) ??
    `Repository #${repositoryContextWorktree.repositoryId}`
  );
}
