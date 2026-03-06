import type { GuardExpression, ProviderExecutionPermissions, WorkItemStatus, WorkItemType } from '@alphred/shared';
import type { WorkItemActorType, WorkItemEventType } from '@alphred/db';

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

export type DashboardReportArtifactContentType = 'text' | 'markdown' | 'json' | 'diff';

export type DashboardWorkflowDraftNode = {
  nodeKey: string;
  displayName: string;
  nodeType: 'agent' | 'human' | 'tool';
  nodeRole?: 'standard' | 'spawner' | 'join';
  maxChildren?: number;
  provider: string | null;
  model?: string | null;
  executionPermissions?: ProviderExecutionPermissions | null;
  reportArtifactContentType?: DashboardReportArtifactContentType | null;
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
  routeOn?: 'success' | 'failure';
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
  archivedAt: string | null;
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
  association?: DashboardRunAssociationSnapshot | null;
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

export type DashboardRunNodeFailedCommandOutputReference = {
  eventIndex: number;
  sequence: number;
  artifactId: number;
  command: string | null;
  exitCode: number | null;
  outputChars: number;
  path: string;
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
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
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
  failedCommandOutputs?: DashboardRunNodeFailedCommandOutputReference[];
  routingDecision: 'approved' | 'changes_requested' | 'blocked' | 'retry' | null;
  failureRoute?: {
    attempted: boolean;
    selectedEdgeId: number | null;
    targetNodeId: number | null;
    targetNodeKey: string | null;
    status: 'selected' | 'no_route' | 'skipped_terminal';
  };
  error: {
    name: string;
    message: string;
    classification: 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';
    stackPreview: string | null;
  } | null;
};

export type DashboardRunNodeDiagnosticCommandOutput = {
  workflowRunId: number;
  runNodeId: number;
  attempt: number;
  eventIndex: number;
  sequence: number;
  artifactId: number;
  command: string | null;
  exitCode: number | null;
  outputChars: number;
  output: string;
  stdout: string | null;
  stderr: string | null;
  createdAt: string;
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
  nodeRole: 'standard' | 'spawner' | 'join';
  spawnerNodeId: number | null;
  joinNodeId: number | null;
  lineageDepth: number;
  sequencePath: string | null;
  sequenceIndex: number;
  attempt: number;
  status: DashboardNodeStatus;
  startedAt: string | null;
  completedAt: string | null;
  latestArtifact: DashboardArtifactSnapshot | null;
  latestRoutingDecision: DashboardRoutingDecisionSnapshot | null;
  latestDiagnostics: DashboardRunNodeDiagnosticsSnapshot | null;
};

export type DashboardFanOutGroupSnapshot = {
  spawnerNodeId: number;
  joinNodeId: number;
  spawnSourceArtifactId: number;
  expectedChildren: number;
  terminalChildren: number;
  completedChildren: number;
  failedChildren: number;
  status: 'pending' | 'ready' | 'released' | 'cancelled';
  childNodeIds: number[];
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
  fanOutGroups: DashboardFanOutGroupSnapshot[];
  artifacts: DashboardArtifactSnapshot[];
  routingDecisions: DashboardRoutingDecisionSnapshot[];
  diagnostics: DashboardRunNodeDiagnosticsSnapshot[];
  worktrees: DashboardRunWorktreeMetadata[];
};

export type DashboardRunAssociationSnapshot = {
  repositoryId: number | null;
  issueId: string | null;
  workItem: {
    id: number;
    type: WorkItemType;
    title: string;
  } | null;
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

export type DashboardArchiveRepositoryResult = {
  repository: DashboardRepositoryState;
};

export type DashboardRestoreRepositoryResult = {
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

export type DashboardRunLaunchPolicyConstraints = {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  allowedSkillIdentifiers: string[] | null;
  allowedMcpServerIdentifiers: string[] | null;
};

export type DashboardRunLaunchRequest = {
  treeKey: string;
  repositoryName?: string;
  branch?: string;
  workItemId?: number;
  issueId?: string;
  executionMode?: 'async' | 'sync';
  executionScope?: DashboardRunExecutionScope;
  nodeSelector?: DashboardRunNodeSelector;
  cleanupWorktree?: boolean;
  policyConstraints?: DashboardRunLaunchPolicyConstraints;
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

export type DashboardRunWorktreeCleanupResult = {
  worktrees: DashboardRunWorktreeMetadata[];
};

export type DashboardBoardEventSnapshot = {
  id: number;
  repositoryId: number;
  workItemId: number;
  eventType: WorkItemEventType;
  actorType: WorkItemActorType;
  actorLabel: string;
  payload: unknown;
  createdAt: string;
};

export type DashboardBoardEventsSnapshot = {
  repositoryId: number;
  latestEventId: number;
  events: DashboardBoardEventSnapshot[];
};

export type DashboardRepositoryBoardBootstrapResult = {
  repositoryId: number;
  latestEventId: number;
  workItems: DashboardWorkItemSnapshot[];
};

export type DashboardWorkItemPolicySnapshot = {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  allowedSkillIdentifiers: string[] | null;
  allowedMcpServerIdentifiers: string[] | null;
  budgets: {
    maxConcurrentTasks: number | null;
    maxConcurrentRuns: number | null;
  };
  requiredGates: {
    breakdownApprovalRequired: boolean;
  };
};

export type DashboardWorkItemEffectivePolicySnapshot = {
  appliesToType: 'epic' | 'task';
  epicWorkItemId: number | null;
  repositoryPolicyId: number | null;
  epicPolicyId: number | null;
  policy: DashboardWorkItemPolicySnapshot;
};

export type DashboardWorkItemLinkedRunSnapshot = {
  workflowRunId: number;
  runStatus: DashboardRunSummary['status'];
  linkedAt: string;
  touchedFiles?: string[] | null;
};

export type DashboardWorkItemSnapshot = {
  id: number;
  repositoryId: number;
  type: WorkItemType;
  status: WorkItemStatus;
  title: string;
  description: string | null;
  parentId: number | null;
  tags: string[] | null;
  plannedFiles: string[] | null;
  assignees: string[] | null;
  priority: number | null;
  estimate: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  effectivePolicy?: DashboardWorkItemEffectivePolicySnapshot | null;
  linkedWorkflowRun?: DashboardWorkItemLinkedRunSnapshot | null;
};

export type DashboardListWorkItemsResult = {
  workItems: DashboardWorkItemSnapshot[];
};

export type DashboardGetWorkItemResult = {
  workItem: DashboardWorkItemSnapshot;
};

export type DashboardCreateWorkItemRequest = {
  repositoryId: number;
  type: WorkItemType;
  status?: WorkItemStatus;
  title: string;
  description?: string | null;
  parentId?: number | null;
  tags?: string[] | null;
  plannedFiles?: string[] | null;
  assignees?: string[] | null;
  priority?: number | null;
  estimate?: number | null;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardCreateWorkItemResult = {
  workItem: DashboardWorkItemSnapshot;
};

export type DashboardUpdateWorkItemFieldsRequest = {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  title?: string;
  description?: string | null;
  tags?: string[] | null;
  plannedFiles?: string[] | null;
  assignees?: string[] | null;
  priority?: number | null;
  estimate?: number | null;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardUpdateWorkItemFieldsResult = {
  workItem: DashboardWorkItemSnapshot;
};

export type DashboardMoveWorkItemStatusRequest = {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  toStatus: WorkItemStatus;
  actorType: WorkItemActorType;
  actorLabel: string;
  linkedWorkflowRunId?: number;
};

export type DashboardMoveWorkItemStatusResult = {
  workItem: DashboardWorkItemSnapshot;
};

export type DashboardStartTaskWorkflowRequest = {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardStartTaskWorkflowResult = {
  workItem: DashboardWorkItemSnapshot;
  workflowRunId: number;
};

export type DashboardRequestWorkItemReplanRequest = {
  repositoryId: number;
  workItemId: number;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardRequestWorkItemReplanResult = {
  repositoryId: number;
  workItemId: number;
  workflowRunId: number;
  eventId: number;
  requestedAt: string;
  plannedButUntouched: string[];
  touchedButUnplanned: string[];
};

export type DashboardSetWorkItemParentRequest = {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  parentId: number | null;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardSetWorkItemParentResult = {
  workItem: DashboardWorkItemSnapshot;
};

export type DashboardWorkItemProposedBreakdownTask = {
  title: string;
  description?: string | null;
  tags?: string[] | null;
  plannedFiles?: string[] | null;
  assignees?: string[] | null;
  priority?: number | null;
  estimate?: number | null;
  links?: string[] | null;
};

export type DashboardStoryBreakdownProposalSnapshot = {
  eventId: number;
  createdAt: string;
  createdTaskIds: number[];
  proposed: {
    tags: string[] | null;
    plannedFiles: string[] | null;
    links: string[] | null;
    tasks: DashboardWorkItemProposedBreakdownTask[];
  };
};

export type DashboardGetStoryBreakdownProposalResult = {
  proposal: DashboardStoryBreakdownProposalSnapshot | null;
};

export type DashboardStoryBreakdownPlannerResult = {
  schemaVersion: 1;
  resultType: 'story_breakdown_result';
  proposed: {
    tags: string[] | null;
    plannedFiles: string[] | null;
    links: string[] | null;
    tasks: DashboardWorkItemProposedBreakdownTask[];
  };
};

export type DashboardLaunchStoryBreakdownRunRequest = {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
};

export type DashboardStoryBreakdownRunError = {
  code: 'auth' | 'transient' | 'invalid_output' | 'conflict';
  message: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
};

export type DashboardStoryBreakdownRunSnapshot = {
  workflowRunId: number;
  runStatus: DashboardRunSummary['status'];
  result: DashboardStoryBreakdownPlannerResult | null;
  error: DashboardStoryBreakdownRunError | null;
};

export type DashboardLaunchStoryBreakdownRunResult = DashboardStoryBreakdownRunSnapshot & {
  mode: 'async';
  status: 'accepted';
};

export type DashboardGetStoryBreakdownRunResult = DashboardStoryBreakdownRunSnapshot;

export type DashboardProposeStoryBreakdownRequest = {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  proposed: {
    tags?: string[] | null;
    plannedFiles?: string[] | null;
    links?: string[] | null;
    tasks: DashboardWorkItemProposedBreakdownTask[];
  };
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardProposeStoryBreakdownResult = {
  story: DashboardWorkItemSnapshot;
  tasks: DashboardWorkItemSnapshot[];
};

export type DashboardApproveStoryBreakdownRequest = {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  actorType: WorkItemActorType;
  actorLabel: string;
};

export type DashboardApproveStoryBreakdownResult = {
  story: DashboardWorkItemSnapshot;
  tasks: DashboardWorkItemSnapshot[];
};

export type DashboardRunStoryWorkflowRequest = {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  actorType: WorkItemActorType;
  actorLabel: string;
  generateOnly?: boolean;
  approveOnly?: boolean;
  approveAndStart?: boolean;
};

export type DashboardRunStoryWorkflowStep = 'move_to_needs_breakdown' | 'generate_breakdown' | 'approve_breakdown' | 'start_ready_tasks';

export type DashboardRunStoryWorkflowStepResult = {
  step: DashboardRunStoryWorkflowStep;
  outcome: 'applied' | 'skipped' | 'blocked' | 'partial_failure';
  message: string;
  startedTaskIds?: number[];
  failedTaskIds?: number[];
};

export type DashboardRunStoryWorkflowResult = {
  story: DashboardWorkItemSnapshot;
  updatedTasks: DashboardWorkItemSnapshot[];
  startedTasks: DashboardWorkItemSnapshot[];
  steps: DashboardRunStoryWorkflowStepResult[];
};
