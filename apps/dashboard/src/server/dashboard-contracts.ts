export type DashboardNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export type DashboardNodeStatusSummary = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
};

export type DashboardWorkflowTreeSummary = {
  id: number;
  treeKey: string;
  version: number;
  name: string;
  description: string | null;
};

export type DashboardRepositoryState = {
  id: number;
  name: string;
  provider: 'github' | 'azure-devops';
  remoteRef: string;
  remoteUrl: string;
  defaultBranch: string;
  branchTemplate: string | null;
  cloneStatus: 'pending' | 'cloned' | 'error';
  localPath: string | null;
};

export type DashboardRunSummary = {
  id: number;
  tree: {
    id: number;
    treeKey: string;
    version: number;
    name: string;
  };
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  nodeSummary: DashboardNodeStatusSummary;
};

export type DashboardArtifactSnapshot = {
  id: number;
  runNodeId: number;
  artifactType: 'report' | 'note' | 'log';
  contentType: 'text' | 'markdown' | 'json' | 'diff';
  contentPreview: string;
  createdAt: string;
};

export type DashboardRoutingDecisionSnapshot = {
  id: number;
  runNodeId: number;
  decisionType: 'approved' | 'changes_requested' | 'blocked' | 'retry' | 'no_route';
  rationale: string | null;
  createdAt: string;
};

export type DashboardRunNodeSnapshot = {
  id: number;
  treeNodeId: number;
  nodeKey: string;
  sequenceIndex: number;
  attempt: number;
  status: DashboardNodeStatus;
  startedAt: string | null;
  completedAt: string | null;
  latestArtifact: DashboardArtifactSnapshot | null;
  latestRoutingDecision: DashboardRoutingDecisionSnapshot | null;
};

export type DashboardRunWorktreeMetadata = {
  id: number;
  runId: number;
  repositoryId: number;
  path: string;
  branch: string;
  commitHash: string | null;
  status: 'active' | 'removed';
  createdAt: string;
  removedAt: string | null;
};

export type DashboardRunDetail = {
  run: DashboardRunSummary;
  nodes: DashboardRunNodeSnapshot[];
  artifacts: DashboardArtifactSnapshot[];
  routingDecisions: DashboardRoutingDecisionSnapshot[];
  worktrees: DashboardRunWorktreeMetadata[];
};

export type DashboardGitHubAuthStatus = {
  authenticated: boolean;
  user: string | null;
  scopes: string[];
  error: string | null;
};

export type DashboardRepositorySyncResult = {
  action: 'cloned' | 'fetched';
  repository: DashboardRepositoryState;
};

export type DashboardCreateRepositoryRequest = {
  name: string;
  provider: 'github';
  remoteRef: string;
};

export type DashboardCreateRepositoryResult = {
  repository: DashboardRepositoryState;
};

export type DashboardRunLaunchRequest = {
  treeKey: string;
  repositoryName?: string;
  branch?: string;
  executionMode?: 'async' | 'sync';
  cleanupWorktree?: boolean;
};

export type DashboardRunLaunchResult = {
  workflowRunId: number;
  mode: 'async' | 'sync';
  status: 'accepted' | 'completed';
  runStatus: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  executionOutcome: string | null;
  executedNodes: number | null;
};
