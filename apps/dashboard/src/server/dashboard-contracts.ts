import type { GuardExpression } from '@alphred/shared';

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

export type DashboardWorkflowTreeStatus = 'draft' | 'published';

export type DashboardWorkflowCatalogItem = {
  treeKey: string;
  name: string;
  description: string | null;
  publishedVersion: number | null;
  draftVersion: number | null;
  updatedAt: string;
};

export type DashboardWorkflowTreeKeyAvailability = {
  treeKey: string;
  available: boolean;
};

export type DashboardWorkflowTemplateKey = 'design-implement-review' | 'blank';

export type DashboardAgentProviderOption = {
  provider: string;
  label: string;
  defaultModel: string | null;
};

export type DashboardAgentModelOption = {
  provider: string;
  model: string;
  label: string;
  isDefault: boolean;
  sortOrder: number;
};

export type DashboardCreateWorkflowRequest = {
  template: DashboardWorkflowTemplateKey;
  name: string;
  treeKey: string;
  description?: string;
};

export type DashboardCreateWorkflowResult = {
  treeKey: string;
  draftVersion: number;
};

export type DashboardDuplicateWorkflowRequest = {
  name: string;
  treeKey: string;
  description?: string;
};

export type DashboardDuplicateWorkflowResult = DashboardCreateWorkflowResult;

export type DashboardWorkflowDraftNode = {
  nodeKey: string;
  displayName: string;
  nodeType: 'agent' | 'human' | 'tool';
  provider: string | null;
  model?: string | null;
  maxRetries: number;
  sequenceIndex: number;
  position: { x: number; y: number } | null;
  promptTemplate:
    | {
        content: string;
        contentType: 'text' | 'markdown';
      }
    | null;
};

export type DashboardWorkflowDraftEdge = {
  sourceNodeKey: string;
  targetNodeKey: string;
  priority: number;
  auto: boolean;
  guardExpression: GuardExpression | null;
};

export type DashboardWorkflowDraftTopology = {
  treeKey: string;
  version: number;
  draftRevision: number;
  name: string;
  description: string | null;
  versionNotes: string | null;
  nodes: DashboardWorkflowDraftNode[];
  edges: DashboardWorkflowDraftEdge[];
  initialRunnableNodeKeys: string[];
};

export type DashboardWorkflowTreeSnapshot = DashboardWorkflowDraftTopology & {
  status: DashboardWorkflowTreeStatus;
};

export type DashboardSaveWorkflowDraftRequest = {
  draftRevision: number;
  name: string;
  description?: string;
  versionNotes?: string;
  nodes: DashboardWorkflowDraftNode[];
  edges: DashboardWorkflowDraftEdge[];
};

export type DashboardWorkflowValidationIssue = {
  code: string;
  message: string;
};

export type DashboardWorkflowValidationResult = {
  errors: DashboardWorkflowValidationIssue[];
  warnings: DashboardWorkflowValidationIssue[];
  initialRunnableNodeKeys: string[];
};

export type DashboardPublishWorkflowDraftRequest = {
  versionNotes?: string;
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
  repository: {
    id: number;
    name: string;
  } | null;
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
