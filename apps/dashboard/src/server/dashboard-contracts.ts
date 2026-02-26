import type { GuardExpression, ProviderExecutionPermissions } from '@alphred/shared';

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

export type DashboardWorkflowNodeOption = {
  nodeKey: string;
  displayName: string;
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
  executionPermissions?: ProviderExecutionPermissions | null;
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

export type DashboardRunNodeDiagnosticEvent = {
  eventIndex: number;
  type: 'system' | 'assistant' | 'result' | 'tool_use' | 'tool_result' | 'usage';
  timestamp: number;
  contentChars: number;
  contentPreview: string;
  metadata: Record<string, unknown> | null;
  usage: {
    deltaTokens: number | null;
    cumulativeTokens: number | null;
  } | null;
};

export type DashboardRunNodeDiagnosticToolEvent = {
  eventIndex: number;
  type: 'tool_use' | 'tool_result';
  timestamp: number;
  toolName: string | null;
  summary: string;
};

export type DashboardRunNodeStreamEvent = {
  id: number;
  workflowRunId: number;
  runNodeId: number;
  attempt: number;
  sequence: number;
  type: 'system' | 'assistant' | 'result' | 'tool_use' | 'tool_result' | 'usage';
  timestamp: number;
  contentChars: number;
  contentPreview: string;
  metadata: Record<string, unknown> | null;
  usage: {
    deltaTokens: number | null;
    cumulativeTokens: number | null;
  } | null;
  createdAt: string;
};

export type DashboardRunNodeStreamSnapshot = {
  workflowRunId: number;
  runNodeId: number;
  attempt: number;
  nodeStatus: DashboardNodeStatus;
  ended: boolean;
  latestSequence: number;
  events: DashboardRunNodeStreamEvent[];
};

export type DashboardRunNodeDiagnosticPayload = {
  schemaVersion: number;
  workflowRunId: number;
  runNodeId: number;
  nodeKey: string;
  attempt: number;
  outcome: 'completed' | 'failed';
  status: 'completed' | 'failed';
  provider: string | null;
  timing: {
    queuedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    persistedAt: string;
  };
  summary: {
    tokensUsed: number;
    eventCount: number;
    retainedEventCount: number;
    droppedEventCount: number;
    toolEventCount: number;
    redacted: boolean;
    truncated: boolean;
  };
  contextHandoff: Record<string, unknown>;
  eventTypeCounts: Partial<Record<DashboardRunNodeDiagnosticEvent['type'], number>>;
  events: DashboardRunNodeDiagnosticEvent[];
  toolEvents: DashboardRunNodeDiagnosticToolEvent[];
  routingDecision: 'approved' | 'changes_requested' | 'blocked' | 'retry' | null;
  error: {
    name: string;
    message: string;
    classification: 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';
    stackPreview: string | null;
  } | null;
};

export type DashboardRunNodeDiagnosticsSnapshot = {
  id: number;
  runNodeId: number;
  attempt: number;
  outcome: 'completed' | 'failed';
  eventCount: number;
  retainedEventCount: number;
  droppedEventCount: number;
  redacted: boolean;
  truncated: boolean;
  payloadChars: number;
  createdAt: string;
  diagnostics: DashboardRunNodeDiagnosticPayload;
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
  latestDiagnostics: DashboardRunNodeDiagnosticsSnapshot | null;
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
  diagnostics: DashboardRunNodeDiagnosticsSnapshot[];
  worktrees: DashboardRunWorktreeMetadata[];
};

export type DashboardGitHubAuthStatus = {
  authenticated: boolean;
  user: string | null;
  scopes: string[];
  error: string | null;
};

export type DashboardRepositorySyncStrategy = 'ff-only' | 'merge' | 'rebase';
export type DashboardRepositorySyncMode = 'fetch' | 'pull';
export type DashboardRepositorySyncStatus = 'fetched' | 'up_to_date' | 'updated' | 'conflicted';

export type DashboardRepositorySyncDetails = {
  mode: DashboardRepositorySyncMode;
  strategy: DashboardRepositorySyncStrategy | null;
  branch: string | null;
  status: DashboardRepositorySyncStatus;
  conflictMessage: string | null;
};

export type DashboardRepositorySyncRequest = {
  strategy?: DashboardRepositorySyncStrategy;
};

export type DashboardRepositorySyncResult = {
  action: 'cloned' | 'fetched';
  repository: DashboardRepositoryState;
  sync: DashboardRepositorySyncDetails;
};

export type DashboardCreateRepositoryRequest = {
  name: string;
  provider: 'github';
  remoteRef: string;
};

export type DashboardCreateRepositoryResult = {
  repository: DashboardRepositoryState;
};

export type DashboardRunExecutionScope = 'full' | 'single_node';

export type DashboardRunNodeSelector =
  | {
      type: 'next_runnable';
    }
  | {
      type: 'node_key';
      nodeKey: string;
    };

export type DashboardRunLaunchRequest = {
  treeKey: string;
  repositoryName?: string;
  branch?: string;
  executionMode?: 'async' | 'sync';
  executionScope?: DashboardRunExecutionScope;
  nodeSelector?: DashboardRunNodeSelector;
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

export type DashboardRunControlAction = 'cancel' | 'pause' | 'resume' | 'retry';

export type DashboardRunControlResult = {
  action: DashboardRunControlAction;
  outcome: 'applied' | 'noop';
  workflowRunId: number;
  previousRunStatus: DashboardRunSummary['status'];
  runStatus: DashboardRunSummary['status'];
  retriedRunNodeIds: number[];
};
