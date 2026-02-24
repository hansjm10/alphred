import type {
  DashboardArtifactSnapshot,
  DashboardNodeStatusSummary,
  DashboardRoutingDecisionSnapshot,
  DashboardRunDetail,
  DashboardRunNodeSnapshot,
  DashboardRunSummary,
  DashboardRunWorktreeMetadata,
} from '../../src/server/dashboard-contracts';

type StatusCountEntry = Readonly<{
  status: keyof DashboardNodeStatusSummary;
  count: number;
}>;

const NODE_STATUS_SUMMARY_ORDER: readonly (keyof DashboardNodeStatusSummary)[] = [
  'running',
  'failed',
  'pending',
  'completed',
  'skipped',
  'cancelled',
];

function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function formatTimestamp(value: string | null, fallback: string): string {
  if (value === null) {
    return fallback;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  return timestamp.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function toNodeSummaryEntries(summary: DashboardNodeStatusSummary): readonly StatusCountEntry[] {
  return NODE_STATUS_SUMMARY_ORDER.map((status) => ({
    status,
    count: summary[status],
  }));
}

function formatNodeSummary(summary: DashboardNodeStatusSummary): string {
  const activeEntries = toNodeSummaryEntries(summary).filter((entry) => entry.count > 0);
  if (activeEntries.length === 0) {
    return 'No node activity recorded';
  }

  return activeEntries
    .map((entry) => `${entry.count} ${toTitleCase(entry.status)}`)
    .join(' · ');
}

function formatArtifactLabel(snapshot: DashboardArtifactSnapshot): string {
  return `${toTitleCase(snapshot.artifactType)} (${toTitleCase(snapshot.contentType)})`;
}

function formatRoutingDecisionLabel(snapshot: DashboardRoutingDecisionSnapshot): string {
  return toTitleCase(snapshot.decisionType);
}

export type RunSummaryViewModel = Readonly<{
  id: number;
  status: DashboardRunSummary['status'];
  workflowLabel: string;
  workflowMetaLabel: string;
  startedAtLabel: string;
  completedAtLabel: string;
  createdAtLabel: string;
  nodeSummaryLabel: string;
}>;

export type RunNodeViewModel = Readonly<{
  id: number;
  nodeKey: string;
  status: DashboardRunNodeSnapshot['status'];
  attemptLabel: string;
  startedAtLabel: string;
  completedAtLabel: string;
  latestArtifactLabel: string | null;
  latestRoutingDecisionLabel: string | null;
}>;

export type RunArtifactViewModel = Readonly<{
  id: number;
  runNodeLabel: string;
  artifactLabel: string;
  createdAtLabel: string;
  preview: string;
}>;

export type RunRoutingDecisionViewModel = Readonly<{
  id: number;
  runNodeLabel: string;
  decisionLabel: string;
  rationaleLabel: string;
  createdAtLabel: string;
}>;

export type RunWorktreeViewModel = Readonly<{
  id: number;
  path: string;
  branch: string;
  status: DashboardRunWorktreeMetadata['status'];
  commitHashLabel: string;
  createdAtLabel: string;
  removedAtLabel: string;
}>;

export type RunDetailViewModel = Readonly<{
  id: number;
  status: DashboardRunSummary['status'];
  workflowLabel: string;
  workflowMetaLabel: string;
  startedAtLabel: string;
  completedAtLabel: string;
  createdAtLabel: string;
  nodeSummaryLabel: string;
  nodes: readonly RunNodeViewModel[];
  artifacts: readonly RunArtifactViewModel[];
  routingDecisions: readonly RunRoutingDecisionViewModel[];
  worktrees: readonly RunWorktreeViewModel[];
}>;

export function isActiveRunStatus(status: DashboardRunSummary['status']): boolean {
  return status === 'running' || status === 'paused';
}

export function toRunSummaryViewModel(run: DashboardRunSummary): RunSummaryViewModel {
  return {
    id: run.id,
    status: run.status,
    workflowLabel: run.tree.name,
    workflowMetaLabel: `${run.tree.treeKey} v${run.tree.version}`,
    startedAtLabel: formatTimestamp(run.startedAt, 'Not started'),
    completedAtLabel: formatTimestamp(run.completedAt, 'In progress'),
    createdAtLabel: formatTimestamp(run.createdAt, 'Unavailable'),
    nodeSummaryLabel: formatNodeSummary(run.nodeSummary),
  };
}

export function toRunSummaryViewModels(runs: readonly DashboardRunSummary[]): readonly RunSummaryViewModel[] {
  return runs.map(toRunSummaryViewModel);
}

function toRunNodeViewModel(node: DashboardRunNodeSnapshot): RunNodeViewModel {
  return {
    id: node.id,
    nodeKey: node.nodeKey,
    status: node.status,
    attemptLabel: `Attempt ${node.attempt}`,
    startedAtLabel: formatTimestamp(node.startedAt, 'Not started'),
    completedAtLabel: formatTimestamp(node.completedAt, 'In progress'),
    latestArtifactLabel: node.latestArtifact ? formatArtifactLabel(node.latestArtifact) : null,
    latestRoutingDecisionLabel: node.latestRoutingDecision ? formatRoutingDecisionLabel(node.latestRoutingDecision) : null,
  };
}

function toRunArtifactViewModel(snapshot: DashboardArtifactSnapshot): RunArtifactViewModel {
  return {
    id: snapshot.id,
    runNodeLabel: `Node #${snapshot.runNodeId}`,
    artifactLabel: formatArtifactLabel(snapshot),
    createdAtLabel: formatTimestamp(snapshot.createdAt, 'Unavailable'),
    preview: snapshot.contentPreview,
  };
}

function toRunRoutingDecisionViewModel(
  snapshot: DashboardRoutingDecisionSnapshot,
): RunRoutingDecisionViewModel {
  return {
    id: snapshot.id,
    runNodeLabel: `Node #${snapshot.runNodeId}`,
    decisionLabel: formatRoutingDecisionLabel(snapshot),
    rationaleLabel: snapshot.rationale?.trim() || 'No rationale provided.',
    createdAtLabel: formatTimestamp(snapshot.createdAt, 'Unavailable'),
  };
}

export function toRunWorktreeViewModel(worktree: DashboardRunWorktreeMetadata): RunWorktreeViewModel {
  return {
    id: worktree.id,
    path: worktree.path,
    branch: worktree.branch,
    status: worktree.status,
    commitHashLabel: worktree.commitHash?.trim() || 'No commit hash recorded',
    createdAtLabel: formatTimestamp(worktree.createdAt, 'Unavailable'),
    removedAtLabel: formatTimestamp(worktree.removedAt, 'Active'),
  };
}

export function toRunWorktreeViewModels(
  worktrees: readonly DashboardRunWorktreeMetadata[],
): readonly RunWorktreeViewModel[] {
  return worktrees.map(toRunWorktreeViewModel);
}

export function toRunDetailViewModel(detail: DashboardRunDetail): RunDetailViewModel {
  const summary = toRunSummaryViewModel(detail.run);

  return {
    id: summary.id,
    status: summary.status,
    workflowLabel: summary.workflowLabel,
    workflowMetaLabel: summary.workflowMetaLabel,
    startedAtLabel: summary.startedAtLabel,
    completedAtLabel: summary.completedAtLabel,
    createdAtLabel: summary.createdAtLabel,
    nodeSummaryLabel: summary.nodeSummaryLabel,
    nodes: detail.nodes.map(toRunNodeViewModel),
    artifacts: detail.artifacts.map(toRunArtifactViewModel),
    routingDecisions: detail.routingDecisions.map(toRunRoutingDecisionViewModel),
    worktrees: toRunWorktreeViewModels(detail.worktrees),
  };
}

function resolveRequestedPath(path: string | string[] | undefined): string | null {
  if (Array.isArray(path)) {
    return path[0] ?? null;
  }

  return path ?? null;
}

export function resolveRunWorktreePath(
  worktrees: readonly RunWorktreeViewModel[],
  path: string | string[] | undefined,
): string | null {
  const requestedPath = resolveRequestedPath(path);

  if (!requestedPath) {
    return worktrees[0]?.path ?? null;
  }

  return worktrees.some((worktree) => worktree.path === requestedPath)
    ? requestedPath
    : (worktrees[0]?.path ?? null);
}
