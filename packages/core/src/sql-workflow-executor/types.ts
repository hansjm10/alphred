import type { RunNodeStatus, WorkflowRunStatus } from '@alphred/db';
import type {
  AgentProviderName,
  ProviderEventType,
  ProviderRunOptions,
  RoutingDecisionSource,
  RoutingDecisionSignal,
} from '@alphred/shared';
import type { PhaseProviderResolver } from '../phaseRunner.js';

export type RunNodeExecutionRow = {
  runNodeId: number;
  treeNodeId: number;
  nodeKey: string;
  nodeRole: string;
  status: RunNodeStatus;
  sequenceIndex: number;
  sequencePath: string | null;
  lineageDepth: number;
  spawnerNodeId: number | null;
  joinNodeId: number | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  maxChildren: number;
  maxRetries: number;
  nodeType: string;
  provider: string | null;
  model: string | null;
  executionPermissions: unknown;
  errorHandlerConfig: unknown;
  prompt: string | null;
  promptContentType: string | null;
};

export type ErrorHandlerConfig =
  | {
      mode: 'disabled';
    }
  | {
      mode: 'custom';
      prompt?: string;
      model?: string;
      provider?: AgentProviderName;
      maxInputChars?: number;
    };

export type WorkflowRunRow = {
  id: number;
  workflowTreeId: number;
  status: WorkflowRunStatus;
};

export type EdgeRow = {
  edgeId: number;
  sourceNodeId: number;
  targetNodeId: number;
  routeOn: 'success' | 'failure' | 'terminal';
  priority: number;
  edgeKind: 'tree' | 'dynamic_spawner_to_child' | 'dynamic_child_to_join';
  auto: number;
  guardExpression: unknown;
};

export type RoutingDecisionType = RoutingDecisionSignal | 'no_route';
export type RouteDecisionSignal = RoutingDecisionSignal;
export type RouteDecisionSource = RoutingDecisionSource;

export type RoutingDecisionRow = {
  id: number;
  runNodeId: number;
  decisionType: RoutingDecisionType;
  createdAt: string;
  attempt: number | null;
};

export type RoutingDecisionSelection = {
  latestByRunNodeId: Map<number, RoutingDecisionRow>;
};

export type TerminalWorkflowRunStatus = Extract<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>;
export type WorkflowExecutionScope = 'full' | 'single_node';

export type WorkflowRunNodeSelector =
  | {
      type: 'next_runnable';
    }
  | {
      type: 'node_key';
      nodeKey: string;
    };

export type NextRunnableSelection = {
  nextRunnableNode: RunNodeExecutionRow | null;
  latestNodeAttempts: RunNodeExecutionRow[];
  handledFailedSourceNodeIds: Set<number>;
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
};

export type RoutingSelection = {
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>;
  incomingEdgesByTargetNodeId: Map<number, EdgeRow[]>;
  selectedEdgeIdBySourceNodeId: Map<number, number>;
  handledFailedSourceNodeIds: Set<number>;
  unresolvedDecisionSourceNodeIds: Set<number>;
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
};

export type LatestArtifact = {
  id: number;
  createdAt: string;
};

export type UpstreamReportArtifact = {
  id: number;
  runNodeId: number;
  contentType: 'text' | 'markdown' | 'json' | 'diff';
  content: string;
  createdAt: string;
};

export type UpstreamArtifactSelection = {
  latestReportsByRunNodeId: Map<number, UpstreamReportArtifact>;
  runNodeIdsWithAnyArtifacts: Set<number>;
};

export type RetryFailureSummaryArtifact = {
  id: number;
  runNodeId: number;
  sourceAttempt: number;
  targetAttempt: number;
  failureArtifactId: number | null;
  content: string;
  createdAt: string;
};

export type FailureLogArtifact = {
  id: number;
  runNodeId: number;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

export type ContextEnvelopeTruncation = {
  applied: boolean;
  method: 'none' | 'head_tail';
  originalChars: number;
  includedChars: number;
  droppedChars: number;
};

export type ContextEnvelopeCandidate = {
  artifactId: number;
  sourceNodeKey: string;
  sourceRunNodeId: number;
  sourceAttempt: number;
  contentType: 'text' | 'markdown' | 'json' | 'diff';
  createdAt: string;
  originalContent: string;
  sha256: string;
};

export type ContextEnvelopeEntry = ContextEnvelopeCandidate & {
  includedContent: string;
  truncation: ContextEnvelopeTruncation;
};

export type ContextHandoffManifest = {
  context_policy_version: number;
  included_artifact_ids: number[];
  included_source_node_keys: string[];
  included_source_run_node_ids: number[];
  included_count: number;
  included_chars_total: number;
  truncated_artifact_ids: number[];
  missing_upstream_artifacts: boolean;
  assembly_timestamp: string;
  no_eligible_artifact_types: boolean;
  budget_overflow: boolean;
  dropped_artifact_ids: number[];
  failure_route_context_included: boolean;
  failure_route_source_node_key: string | null;
  failure_route_source_run_node_id: number | null;
  failure_route_failure_artifact_id: number | null;
  failure_route_retry_summary_artifact_id: number | null;
  failure_route_context_chars: number;
  failure_route_context_truncated: boolean;
  retry_summary_included: boolean;
  retry_summary_artifact_id: number | null;
  retry_summary_source_attempt: number | null;
  retry_summary_target_attempt: number | null;
  retry_summary_chars: number;
  retry_summary_truncated: boolean;
};

export type AssembledUpstreamContext = {
  contextEntries: string[];
  manifest: ContextHandoffManifest;
};

export type DiagnosticUsageSnapshot = {
  deltaTokens: number | null;
  cumulativeTokens: number | null;
};

export type RunNodeTokenBreakdown = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

export type StreamUsageState = {
  cumulativeTokens: number | null;
};

export type DiagnosticEvent = {
  eventIndex: number;
  type: ProviderEventType;
  timestamp: number;
  contentChars: number;
  contentPreview: string;
  metadata: Record<string, unknown> | null;
  usage: DiagnosticUsageSnapshot | null;
};

export type DiagnosticToolEvent = {
  eventIndex: number;
  type: 'tool_use' | 'tool_result';
  timestamp: number;
  toolName: string | null;
  summary: string;
};

export type DiagnosticCommandOutputReference = {
  eventIndex: number;
  sequence: number;
  artifactId: number;
  command: string | null;
  exitCode: number | null;
  outputChars: number;
  path: string;
};

export type DiagnosticErrorDetails = {
  name: string;
  message: string;
  classification: 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';
  stackPreview: string | null;
};

export type RunNodeErrorHandlerDiagnostics = {
  attempted: boolean;
  status: 'completed' | 'failed' | 'skipped';
  summaryArtifactId: number | null;
  sourceAttempt: number;
  targetAttempt: number | null;
  provider: string | null;
  model: string | null;
  eventCount: number;
  tokensUsed: number;
  errorMessage: string | null;
};

export type RunNodeFailureRouteDiagnostics = {
  attempted: boolean;
  selectedEdgeId: number | null;
  targetNodeId: number | null;
  targetNodeKey: string | null;
  status: 'selected' | 'no_route' | 'skipped_terminal';
};

export type RunNodeDiagnosticsPayload = {
  schemaVersion: 1;
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
  contextHandoff: ContextHandoffManifest;
  eventTypeCounts: Partial<Record<ProviderEventType, number>>;
  events: DiagnosticEvent[];
  toolEvents: DiagnosticToolEvent[];
  failedCommandOutputs?: DiagnosticCommandOutputReference[];
  routingDecision: RouteDecisionSignal | null;
  failureRoute?: RunNodeFailureRouteDiagnostics;
  error: DiagnosticErrorDetails | null;
  errorHandler?: RunNodeErrorHandlerDiagnostics;
};

export type CompletedNodeRoutingOutcome = {
  decisionType: RoutingDecisionType | null;
  selectedEdgeId: number | null;
};

export type ExecuteWorkflowRunParams = {
  workflowRunId: number;
  options: ProviderRunOptions;
  maxSteps?: number;
};

export type ExecuteSingleNodeRunParams = {
  workflowRunId: number;
  options: ProviderRunOptions;
  nodeSelector?: WorkflowRunNodeSelector;
};

export type ValidateSingleNodeSelectionParams = {
  workflowRunId: number;
  nodeSelector?: WorkflowRunNodeSelector;
};

export type ExecuteNextRunnableNodeParams = {
  workflowRunId: number;
  options: ProviderRunOptions;
};

export type ExecuteNextRunnableNodeResult =
  | {
      outcome: 'executed';
      workflowRunId: number;
      runNodeId: number;
      nodeKey: string;
      runNodeStatus: 'completed' | 'failed';
      runStatus: WorkflowRunStatus;
      artifactId: number;
    }
  | {
      outcome: 'run_terminal';
      workflowRunId: number;
      runStatus: WorkflowRunStatus;
    }
  | {
      outcome: 'blocked';
      workflowRunId: number;
      runStatus: WorkflowRunStatus;
    }
  | {
      outcome: 'no_runnable';
      workflowRunId: number;
      runStatus: WorkflowRunStatus;
    };

export type ExecuteWorkflowRunResult = {
  workflowRunId: number;
  executedNodes: number;
  finalStep: Exclude<ExecuteNextRunnableNodeResult, { outcome: 'executed' }>;
};

export type WorkflowRunExecutionValidationErrorCode =
  | 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_FOUND'
  | 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_EXECUTABLE';

export class WorkflowRunExecutionValidationError extends Error {
  readonly code: WorkflowRunExecutionValidationErrorCode;
  readonly workflowRunId: number;
  readonly nodeSelector: WorkflowRunNodeSelector;

  constructor(
    code: WorkflowRunExecutionValidationErrorCode,
    message: string,
    options: {
      workflowRunId: number;
      nodeSelector: WorkflowRunNodeSelector;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'WorkflowRunExecutionValidationError';
    this.code = code;
    this.workflowRunId = options.workflowRunId;
    this.nodeSelector = options.nodeSelector;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type WorkflowRunControlAction = 'cancel' | 'pause' | 'resume' | 'retry';

export type WorkflowRunControlErrorCode =
  | 'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION'
  | 'WORKFLOW_RUN_CONTROL_CONCURRENT_CONFLICT'
  | 'WORKFLOW_RUN_CONTROL_RETRY_TARGETS_NOT_FOUND';

export class WorkflowRunControlError extends Error {
  readonly code: WorkflowRunControlErrorCode;
  readonly action: WorkflowRunControlAction;
  readonly workflowRunId: number;
  readonly runStatus: WorkflowRunStatus;

  constructor(
    code: WorkflowRunControlErrorCode,
    message: string,
    options: {
      action: WorkflowRunControlAction;
      workflowRunId: number;
      runStatus: WorkflowRunStatus;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'WorkflowRunControlError';
    this.code = code;
    this.action = options.action;
    this.workflowRunId = options.workflowRunId;
    this.runStatus = options.runStatus;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type WorkflowRunControlParams = {
  workflowRunId: number;
};

export type WorkflowRunControlResult = {
  action: WorkflowRunControlAction;
  outcome: 'applied' | 'noop';
  workflowRunId: number;
  previousRunStatus: WorkflowRunStatus;
  runStatus: WorkflowRunStatus;
  retriedRunNodeIds: number[];
};

export type SqlWorkflowExecutorDependencies = {
  resolveProvider: PhaseProviderResolver;
  onRunTerminal?: (params: { workflowRunId: number; runStatus: TerminalWorkflowRunStatus }) => Promise<void> | void;
};

export type SqlWorkflowExecutor = {
  validateSingleNodeSelection(params: ValidateSingleNodeSelectionParams): void;
  executeSingleNode(params: ExecuteSingleNodeRunParams): Promise<ExecuteWorkflowRunResult>;
  executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult>;
  executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult>;
  cancelRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  pauseRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  resumeRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  retryRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
};
