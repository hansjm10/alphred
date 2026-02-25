import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  guardDefinitions,
  phaseArtifacts,
  promptTemplates,
  runNodeDiagnostics,
  runNodeStreamEvents,
  runNodes,
  routingDecisions,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  treeEdges,
  treeNodes,
  workflowRuns,
  type AlphredDatabase,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import {
  compareStringsByCodeUnit,
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type AgentProviderName,
  type GuardCondition,
  type GuardExpression,
  type PhaseDefinition,
  type ProviderEvent,
  type ProviderEventType,
  type ProviderExecutionPermissions,
  type ProviderRunOptions,
  type RoutingDecisionSignal,
} from '@alphred/shared';
import { evaluateGuard } from './guards.js';
import { PhaseRunError, runPhase, type PhaseProviderResolver } from './phaseRunner.js';

type RunNodeExecutionRow = {
  runNodeId: number;
  treeNodeId: number;
  nodeKey: string;
  status: RunNodeStatus;
  sequenceIndex: number;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  maxRetries: number;
  nodeType: string;
  provider: string | null;
  model: string | null;
  executionPermissions: unknown;
  prompt: string | null;
  promptContentType: string | null;
};

type WorkflowRunRow = {
  id: number;
  workflowTreeId: number;
  status: WorkflowRunStatus;
};

type EdgeRow = {
  edgeId: number;
  sourceNodeId: number;
  targetNodeId: number;
  priority: number;
  auto: number;
  guardExpression: unknown;
};

type RoutingDecisionType = RoutingDecisionSignal | 'no_route';
type RouteDecisionSignal = RoutingDecisionSignal;

type RoutingDecisionRow = {
  id: number;
  runNodeId: number;
  decisionType: RoutingDecisionType;
  createdAt: string;
  attempt: number | null;
};

type RoutingDecisionSelection = {
  latestByRunNodeId: Map<number, RoutingDecisionRow>;
};

type TerminalWorkflowRunStatus = Extract<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>;

type NextRunnableSelection = {
  nextRunnableNode: RunNodeExecutionRow | null;
  latestNodeAttempts: RunNodeExecutionRow[];
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
};

type RoutingSelection = {
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>;
  incomingEdgesByTargetNodeId: Map<number, EdgeRow[]>;
  selectedEdgeIdBySourceNodeId: Map<number, number>;
  unresolvedDecisionSourceNodeIds: Set<number>;
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
};

type LatestArtifact = {
  id: number;
  createdAt: string;
};

type UpstreamReportArtifact = {
  id: number;
  runNodeId: number;
  contentType: 'text' | 'markdown' | 'json' | 'diff';
  content: string;
  createdAt: string;
};

type UpstreamArtifactSelection = {
  latestReportsByRunNodeId: Map<number, UpstreamReportArtifact>;
  runNodeIdsWithAnyArtifacts: Set<number>;
};

type ContextEnvelopeTruncation = {
  applied: boolean;
  method: 'none' | 'head_tail';
  originalChars: number;
  includedChars: number;
  droppedChars: number;
};

type ContextEnvelopeCandidate = {
  artifactId: number;
  sourceNodeKey: string;
  sourceRunNodeId: number;
  sourceAttempt: number;
  contentType: 'text' | 'markdown' | 'json' | 'diff';
  createdAt: string;
  originalContent: string;
  sha256: string;
};

type ContextEnvelopeEntry = ContextEnvelopeCandidate & {
  includedContent: string;
  truncation: ContextEnvelopeTruncation;
};

type ContextHandoffManifest = {
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
};

type AssembledUpstreamContext = {
  contextEntries: string[];
  manifest: ContextHandoffManifest;
};

type DiagnosticUsageSnapshot = {
  deltaTokens: number | null;
  cumulativeTokens: number | null;
};

type StreamUsageState = {
  cumulativeTokens: number | null;
};

type DiagnosticEvent = {
  eventIndex: number;
  type: ProviderEventType;
  timestamp: number;
  contentChars: number;
  contentPreview: string;
  metadata: Record<string, unknown> | null;
  usage: DiagnosticUsageSnapshot | null;
};

type DiagnosticToolEvent = {
  eventIndex: number;
  type: 'tool_use' | 'tool_result';
  timestamp: number;
  toolName: string | null;
  summary: string;
};

type DiagnosticErrorDetails = {
  name: string;
  message: string;
  classification: 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';
  stackPreview: string | null;
};

type RunNodeDiagnosticsPayload = {
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
  routingDecision: RouteDecisionSignal | null;
  error: DiagnosticErrorDetails | null;
};

type CompletedNodeRoutingOutcome = {
  decisionType: RoutingDecisionType | null;
  selectedEdgeId: number | null;
};

export type ExecuteWorkflowRunParams = {
  workflowRunId: number;
  options: ProviderRunOptions;
  maxSteps?: number;
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
  executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult>;
  executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult>;
  cancelRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  pauseRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  resumeRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
  retryRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult>;
};

const artifactContentTypes = new Set(['text', 'markdown', 'json', 'diff']);
const runTerminalStatuses = new Set<WorkflowRunStatus>(['completed', 'failed', 'cancelled']);
const guardOperators: ReadonlySet<GuardCondition['operator']> = new Set(['==', '!=', '>', '<', '>=', '<=']);
const executionPermissionKeys = new Set([
  'approvalPolicy',
  'sandboxMode',
  'networkAccessEnabled',
  'additionalDirectories',
  'webSearchMode',
]);
const executionApprovalPolicies = new Set(providerApprovalPolicies);
const executionSandboxModes = new Set(providerSandboxModes);
const executionWebSearchModes = new Set(providerWebSearchModes);
const CONTEXT_POLICY_VERSION = 1;
const MAX_UPSTREAM_ARTIFACTS = 4;
const MAX_CONTEXT_CHARS_TOTAL = 32_000;
const MAX_CHARS_PER_ARTIFACT = 12_000;
const MIN_REMAINING_CONTEXT_CHARS = 1_000;
const RUN_NODE_DIAGNOSTICS_SCHEMA_VERSION = 1;
const MAX_DIAGNOSTIC_EVENTS = 120;
const MAX_DIAGNOSTIC_PAYLOAD_CHARS = 48_000;
const MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS = 600;
const MAX_DIAGNOSTIC_METADATA_CHARS = 2_000;
const MAX_DIAGNOSTIC_ERROR_STACK_CHARS = 1_600;
const MAX_REDACTION_DEPTH = 6;
const MAX_REDACTION_ARRAY_LENGTH = 24;
const MAX_CONTROL_PRECONDITION_RETRIES = 5;

const sensitiveMetadataKeyPattern =
  /(token|secret|password|authorization|auth|api[_-]?key|session|cookie|credential)/i;
const sensitiveStringPattern =
  /(gh[pousr]_\w{8,}|github_pat_\w{12,}|sk-[A-Z0-9]{10,}|Bearer\s+[-._~+/A-Z0-9]+=*)/i;

function toRunNodeStatus(value: string): RunNodeStatus {
  return value as RunNodeStatus;
}

function toWorkflowRunStatus(value: string): WorkflowRunStatus {
  return value as WorkflowRunStatus;
}

function toRoutingDecisionType(value: string): RoutingDecisionType {
  switch (value) {
    case 'approved':
    case 'changes_requested':
    case 'blocked':
    case 'retry':
    case 'no_route':
      return value;
    default:
      throw new Error(`Unsupported routing decision type '${value}'.`);
  }
}

function normalizeArtifactContentType(value: string | null): 'text' | 'markdown' | 'json' | 'diff' {
  if (value && artifactContentTypes.has(value)) {
    return value as 'text' | 'markdown' | 'json' | 'diff';
  }

  return 'markdown';
}

function hashContentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function truncateHeadTail(content: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }

  if (content.length <= limit) {
    return content;
  }

  const headChars = Math.floor(limit / 2);
  const tailChars = limit - headChars;
  return `${content.slice(0, headChars)}${content.slice(content.length - tailChars)}`;
}

function buildTruncationMetadata(originalChars: number, includedChars: number): ContextEnvelopeTruncation {
  const droppedChars = Math.max(originalChars - includedChars, 0);
  return {
    applied: droppedChars > 0,
    method: droppedChars > 0 ? 'head_tail' : 'none',
    originalChars,
    includedChars,
    droppedChars,
  };
}

function serializeContextEnvelope(params: {
  workflowRunId: number;
  targetNodeKey: string;
  entry: ContextEnvelopeEntry;
}): string {
  const lines = [
    'ALPHRED_UPSTREAM_ARTIFACT v1',
    `policy_version: ${CONTEXT_POLICY_VERSION}`,
    'untrusted_data: true',
    `workflow_run_id: ${params.workflowRunId}`,
    `target_node_key: ${params.targetNodeKey}`,
    `source_node_key: ${params.entry.sourceNodeKey}`,
    `source_run_node_id: ${params.entry.sourceRunNodeId}`,
    `source_attempt: ${params.entry.sourceAttempt}`,
    `artifact_id: ${params.entry.artifactId}`,
    'artifact_type: report',
    `content_type: ${params.entry.contentType}`,
    `created_at: ${params.entry.createdAt}`,
    `sha256: ${params.entry.sha256}`,
    'truncation:',
    `  applied: ${params.entry.truncation.applied ? 'true' : 'false'}`,
    `  method: ${params.entry.truncation.method}`,
    `  original_chars: ${params.entry.truncation.originalChars}`,
    `  included_chars: ${params.entry.truncation.includedChars}`,
    `  dropped_chars: ${params.entry.truncation.droppedChars}`,
    'content:',
    '<<<BEGIN>>>',
  ];

  return `${lines.join('\n')}\n${params.entry.includedContent}\n<<<END>>>`;
}

function compareNodeOrder(a: RunNodeExecutionRow, b: RunNodeExecutionRow): number {
  const bySequence = a.sequenceIndex - b.sequenceIndex;
  if (bySequence !== 0) {
    return bySequence;
  }

  const byNodeKey = compareStringsByCodeUnit(a.nodeKey, b.nodeKey);
  if (byNodeKey !== 0) {
    return byNodeKey;
  }

  const byAttempt = a.attempt - b.attempt;
  if (byAttempt !== 0) {
    return byAttempt;
  }

  return a.runNodeId - b.runNodeId;
}

function getLatestRunNodeAttempts(rows: RunNodeExecutionRow[]): RunNodeExecutionRow[] {
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>();
  for (const row of rows) {
    const current = latestByTreeNodeId.get(row.treeNodeId);
    if (!current || row.attempt > current.attempt || (row.attempt === current.attempt && row.runNodeId > current.runNodeId)) {
      latestByTreeNodeId.set(row.treeNodeId, row);
    }
  }

  return [...latestByTreeNodeId.values()].sort(compareNodeOrder);
}

function compareUpstreamSourceOrder(a: RunNodeExecutionRow, b: RunNodeExecutionRow): number {
  const bySequence = a.sequenceIndex - b.sequenceIndex;
  if (bySequence !== 0) {
    return bySequence;
  }

  const byNodeKey = compareStringsByCodeUnit(a.nodeKey, b.nodeKey);
  if (byNodeKey !== 0) {
    return byNodeKey;
  }

  return a.runNodeId - b.runNodeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSupportedRunNodeExecutionPermissionKeys(value: Record<string, unknown>, nodeKey: string): void {
  for (const key of Object.keys(value)) {
    if (executionPermissionKeys.has(key)) {
      continue;
    }

    throw new Error(`Run node "${nodeKey}" execution permissions include unsupported field "${key}".`);
  }
}

function parseRunNodeExecutionApprovalPolicy(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerApprovalPolicies)[number] | undefined {
  const approvalPolicy = value.approvalPolicy;
  if (approvalPolicy === undefined) {
    return undefined;
  }

  if (
    typeof approvalPolicy !== 'string'
    || !executionApprovalPolicies.has(approvalPolicy as (typeof providerApprovalPolicies)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution approval policy.`);
  }

  return approvalPolicy as (typeof providerApprovalPolicies)[number];
}

function parseRunNodeExecutionSandboxMode(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerSandboxModes)[number] | undefined {
  const sandboxMode = value.sandboxMode;
  if (sandboxMode === undefined) {
    return undefined;
  }

  if (
    typeof sandboxMode !== 'string'
    || !executionSandboxModes.has(sandboxMode as (typeof providerSandboxModes)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution sandbox mode.`);
  }

  return sandboxMode as (typeof providerSandboxModes)[number];
}

function parseRunNodeExecutionNetworkAccessEnabled(
  value: Record<string, unknown>,
  nodeKey: string,
): boolean | undefined {
  const networkAccessEnabled = value.networkAccessEnabled;
  if (networkAccessEnabled === undefined) {
    return undefined;
  }

  if (typeof networkAccessEnabled !== 'boolean') {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution networkAccessEnabled value.`);
  }

  return networkAccessEnabled;
}

function parseRunNodeExecutionAdditionalDirectories(
  value: Record<string, unknown>,
  nodeKey: string,
): string[] | undefined {
  const additionalDirectories = value.additionalDirectories;
  if (additionalDirectories === undefined) {
    return undefined;
  }

  if (!Array.isArray(additionalDirectories)) {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution additionalDirectories value.`);
  }

  const normalizedDirectories = additionalDirectories.map((directory, index) => {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new TypeError(
        `Run node "${nodeKey}" has invalid execution additionalDirectories entry at index ${index}.`,
      );
    }

    return directory.trim();
  });

  if (normalizedDirectories.length === 0) {
    throw new Error(`Run node "${nodeKey}" must provide at least one execution additional directory.`);
  }

  return normalizedDirectories;
}

function parseRunNodeExecutionWebSearchMode(
  value: Record<string, unknown>,
  nodeKey: string,
): (typeof providerWebSearchModes)[number] | undefined {
  const webSearchMode = value.webSearchMode;
  if (webSearchMode === undefined) {
    return undefined;
  }

  if (
    typeof webSearchMode !== 'string'
    || !executionWebSearchModes.has(webSearchMode as (typeof providerWebSearchModes)[number])
  ) {
    throw new Error(`Run node "${nodeKey}" has invalid execution web search mode.`);
  }

  return webSearchMode as (typeof providerWebSearchModes)[number];
}

function normalizeRunNodeExecutionPermissions(
  value: unknown,
  nodeKey: string,
): ProviderExecutionPermissions | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new TypeError(`Run node "${nodeKey}" has invalid execution permissions payload.`);
  }

  assertSupportedRunNodeExecutionPermissionKeys(value, nodeKey);

  const normalized: ProviderExecutionPermissions = {};
  const approvalPolicy = parseRunNodeExecutionApprovalPolicy(value, nodeKey);
  if (approvalPolicy !== undefined) {
    normalized.approvalPolicy = approvalPolicy;
  }

  const sandboxMode = parseRunNodeExecutionSandboxMode(value, nodeKey);
  if (sandboxMode !== undefined) {
    normalized.sandboxMode = sandboxMode;
  }

  const networkAccessEnabled = parseRunNodeExecutionNetworkAccessEnabled(value, nodeKey);
  if (networkAccessEnabled !== undefined) {
    normalized.networkAccessEnabled = networkAccessEnabled;
  }

  const additionalDirectories = parseRunNodeExecutionAdditionalDirectories(value, nodeKey);
  if (additionalDirectories !== undefined) {
    normalized.additionalDirectories = additionalDirectories;
  }

  const webSearchMode = parseRunNodeExecutionWebSearchMode(value, nodeKey);
  if (webSearchMode !== undefined) {
    normalized.webSearchMode = webSearchMode;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeExecutionPermissions(
  basePermissions: ProviderExecutionPermissions | undefined,
  nodePermissions: ProviderExecutionPermissions | undefined,
): ProviderExecutionPermissions | undefined {
  if (!basePermissions && !nodePermissions) {
    return undefined;
  }

  if (!basePermissions) {
    return nodePermissions;
  }

  if (!nodePermissions) {
    return basePermissions;
  }

  return {
    ...basePermissions,
    ...nodePermissions,
  };
}

function readRoutingDecisionAttempt(rawOutput: unknown): number | null {
  if (!isRecord(rawOutput)) {
    return null;
  }

  const attempt = rawOutput.attempt;
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

function isGuardExpression(value: unknown): value is GuardExpression {
  if (!isRecord(value)) {
    return false;
  }

  if ('logic' in value) {
    if ((value.logic !== 'and' && value.logic !== 'or') || !Array.isArray(value.conditions)) {
      return false;
    }

    return value.conditions.every(isGuardExpression);
  }

  if (!('field' in value) || !('operator' in value) || !('value' in value)) {
    return false;
  }

  if (typeof value.field !== 'string') {
    return false;
  }

  if (!guardOperators.has(value.operator as GuardCondition['operator'])) {
    return false;
  }

  return ['string', 'number', 'boolean'].includes(typeof value.value);
}

function doesEdgeMatchDecision(edge: EdgeRow, decisionType: RoutingDecisionType | null): boolean {
  if (edge.auto === 1) {
    return true;
  }

  // Guarded routes require a concrete structured decision signal.
  if (decisionType === null || decisionType === 'no_route') {
    return false;
  }

  if (!isGuardExpression(edge.guardExpression)) {
    throw new Error(`Invalid guard expression for tree edge id=${edge.edgeId}.`);
  }

  return evaluateGuard(edge.guardExpression, { decision: decisionType });
}

function selectFirstMatchingOutgoingEdge(
  outgoingEdges: EdgeRow[],
  decisionType: RoutingDecisionType | null,
): EdgeRow | null {
  for (const edge of outgoingEdges) {
    if (doesEdgeMatchDecision(edge, decisionType)) {
      return edge;
    }
  }

  return null;
}

function loadLatestRoutingDecisionsByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
): RoutingDecisionSelection {
  const rows = db
    .select({
      id: routingDecisions.id,
      runNodeId: routingDecisions.runNodeId,
      decisionType: routingDecisions.decisionType,
      createdAt: routingDecisions.createdAt,
      rawOutput: routingDecisions.rawOutput,
    })
    .from(routingDecisions)
    .where(eq(routingDecisions.workflowRunId, workflowRunId))
    .orderBy(asc(routingDecisions.createdAt), asc(routingDecisions.id))
    .all();

  const latestByRunNodeId = new Map<number, RoutingDecisionRow>();
  for (const row of rows) {
    latestByRunNodeId.set(row.runNodeId, {
      id: row.id,
      runNodeId: row.runNodeId,
      decisionType: toRoutingDecisionType(row.decisionType),
      createdAt: row.createdAt,
      attempt: readRoutingDecisionAttempt(row.rawOutput),
    });
  }

  return {
    latestByRunNodeId,
  };
}

function loadLatestArtifactsByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
): Map<number, LatestArtifact> {
  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      createdAt: phaseArtifacts.createdAt,
    })
    .from(phaseArtifacts)
    .where(eq(phaseArtifacts.workflowRunId, workflowRunId))
    .orderBy(asc(phaseArtifacts.id))
    .all();

  const latestByRunNodeId = new Map<number, LatestArtifact>();
  for (const row of rows) {
    latestByRunNodeId.set(row.runNodeId, {
      id: row.id,
      createdAt: row.createdAt,
    });
  }

  return latestByRunNodeId;
}

function loadUpstreamArtifactSelectionByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
  runNodeIds: number[],
): UpstreamArtifactSelection {
  const latestReportsByRunNodeId = new Map<number, UpstreamReportArtifact>();
  const runNodeIdsWithAnyArtifacts = new Set<number>();
  if (runNodeIds.length === 0) {
    return {
      latestReportsByRunNodeId,
      runNodeIdsWithAnyArtifacts,
    };
  }

  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      artifactType: phaseArtifacts.artifactType,
      contentType: phaseArtifacts.contentType,
      content: phaseArtifacts.content,
      createdAt: phaseArtifacts.createdAt,
    })
    .from(phaseArtifacts)
    .where(and(eq(phaseArtifacts.workflowRunId, workflowRunId), inArray(phaseArtifacts.runNodeId, runNodeIds)))
    .orderBy(asc(phaseArtifacts.createdAt), asc(phaseArtifacts.id))
    .all();

  for (const row of rows) {
    runNodeIdsWithAnyArtifacts.add(row.runNodeId);
    if (row.artifactType !== 'report') {
      continue;
    }

    latestReportsByRunNodeId.set(row.runNodeId, {
      id: row.id,
      runNodeId: row.runNodeId,
      contentType: normalizeArtifactContentType(row.contentType),
      content: row.content,
      createdAt: row.createdAt,
    });
  }

  return {
    latestReportsByRunNodeId,
    runNodeIdsWithAnyArtifacts,
  };
}

function appendEdgeToNodeMap(edgesByNodeId: Map<number, EdgeRow[]>, nodeId: number, edge: EdgeRow): void {
  const edges = edgesByNodeId.get(nodeId);
  if (edges) {
    edges.push(edge);
    return;
  }
  edgesByNodeId.set(nodeId, [edge]);
}

function resolveApplicableRoutingDecision(
  sourceNode: RunNodeExecutionRow,
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RoutingDecisionRow | null {
  const persistedDecision = latestRoutingDecisionsByRunNodeId.get(sourceNode.runNodeId) ?? null;
  if (!persistedDecision) {
    return null;
  }

  const latestArtifact = latestArtifactsByRunNodeId.get(sourceNode.runNodeId) ?? null;
  const hasStaleAttempt = persistedDecision.attempt === null || persistedDecision.attempt < sourceNode.attempt;
  const hasStaleTimestamp = latestArtifact !== null && persistedDecision.createdAt < latestArtifact.createdAt;
  return hasStaleAttempt || hasStaleTimestamp ? null : persistedDecision;
}

function resolveCompletedSourceNodeRouting(
  sourceNode: RunNodeExecutionRow,
  outgoingEdges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): {
  selectedEdgeId: number | null;
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
} {
  if (outgoingEdges.length === 0) {
    return {
      selectedEdgeId: null,
      hasNoRouteDecision: false,
      hasUnresolvedDecision: false,
    };
  }

  const decision = resolveApplicableRoutingDecision(
    sourceNode,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );
  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decision?.decisionType ?? null);
  if (matchingEdge) {
    return {
      selectedEdgeId: matchingEdge.edgeId,
      hasNoRouteDecision: false,
      hasUnresolvedDecision: false,
    };
  }

  if (decision) {
    return {
      selectedEdgeId: null,
      hasNoRouteDecision: true,
      hasUnresolvedDecision: false,
    };
  }

  return {
    selectedEdgeId: null,
    hasNoRouteDecision: false,
    hasUnresolvedDecision: true,
  };
}

function buildRoutingSelection(
  latestNodeAttempts: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RoutingSelection {
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>(latestNodeAttempts.map(row => [row.treeNodeId, row]));
  const incomingEdgesByTargetNodeId = new Map<number, EdgeRow[]>();
  const outgoingEdgesBySourceNodeId = new Map<number, EdgeRow[]>();
  for (const edge of edges) {
    appendEdgeToNodeMap(incomingEdgesByTargetNodeId, edge.targetNodeId, edge);
    appendEdgeToNodeMap(outgoingEdgesBySourceNodeId, edge.sourceNodeId, edge);
  }

  const selectedEdgeIdBySourceNodeId = new Map<number, number>();
  const unresolvedDecisionSourceNodeIds = new Set<number>();
  let hasNoRouteDecision = false;
  for (const sourceNode of latestNodeAttempts) {
    if (sourceNode.status !== 'completed') {
      continue;
    }

    const outgoingEdges = outgoingEdgesBySourceNodeId.get(sourceNode.treeNodeId) ?? [];
    const routing = resolveCompletedSourceNodeRouting(
      sourceNode,
      outgoingEdges,
      latestRoutingDecisionsByRunNodeId,
      latestArtifactsByRunNodeId,
    );
    if (routing.selectedEdgeId !== null) {
      selectedEdgeIdBySourceNodeId.set(sourceNode.treeNodeId, routing.selectedEdgeId);
    }
    if (routing.hasNoRouteDecision) {
      hasNoRouteDecision = true;
    }
    if (routing.hasUnresolvedDecision) {
      unresolvedDecisionSourceNodeIds.add(sourceNode.treeNodeId);
    }
  }

  return {
    latestByTreeNodeId,
    incomingEdgesByTargetNodeId,
    selectedEdgeIdBySourceNodeId,
    unresolvedDecisionSourceNodeIds,
    hasNoRouteDecision,
    hasUnresolvedDecision: unresolvedDecisionSourceNodeIds.size > 0,
  };
}

function selectDirectPredecessorNodes(
  targetNode: RunNodeExecutionRow,
  latestNodeAttempts: RunNodeExecutionRow[],
  edgeRows: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RunNodeExecutionRow[] {
  const routingSelection = buildRoutingSelection(
    latestNodeAttempts,
    edgeRows,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );
  const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(targetNode.treeNodeId) ?? [];

  const predecessors: RunNodeExecutionRow[] = [];
  const seenSourceNodeIds = new Set<number>();
  for (const edge of incomingEdges) {
    if (routingSelection.selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      continue;
    }

    if (seenSourceNodeIds.has(edge.sourceNodeId)) {
      continue;
    }

    const sourceNode = routingSelection.latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      continue;
    }

    seenSourceNodeIds.add(edge.sourceNodeId);
    predecessors.push(sourceNode);
  }

  return predecessors.sort(compareUpstreamSourceOrder);
}

function resolveIncludedContentForContextCandidate(
  candidate: ContextEnvelopeCandidate,
  remainingChars: number,
): {
  includedContent: string | null;
  budgetOverflow: boolean;
} {
  if (remainingChars <= 0) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  let includedContent = truncateHeadTail(candidate.originalContent, MAX_CHARS_PER_ARTIFACT);
  if (includedContent.length <= remainingChars) {
    return {
      includedContent,
      budgetOverflow: false,
    };
  }

  if (remainingChars < MIN_REMAINING_CONTEXT_CHARS) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  includedContent = truncateHeadTail(candidate.originalContent, Math.min(MAX_CHARS_PER_ARTIFACT, remainingChars));
  if (includedContent.length <= 0) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  return {
    includedContent,
    budgetOverflow: true,
  };
}

function assembleUpstreamArtifactContext(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    targetNode: RunNodeExecutionRow;
    latestNodeAttempts: RunNodeExecutionRow[];
    edgeRows: EdgeRow[];
    latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>;
    latestArtifactsByRunNodeId: Map<number, LatestArtifact>;
  },
): AssembledUpstreamContext {
  const directPredecessors = selectDirectPredecessorNodes(
    params.targetNode,
    params.latestNodeAttempts,
    params.edgeRows,
    params.latestRoutingDecisionsByRunNodeId,
    params.latestArtifactsByRunNodeId,
  );
  const predecessorRunNodeIds = directPredecessors.map(node => node.runNodeId);
  const artifactSelection = loadUpstreamArtifactSelectionByRunNodeId(db, params.workflowRunId, predecessorRunNodeIds);

  const candidateEntries: ContextEnvelopeCandidate[] = [];
  for (const sourceNode of directPredecessors) {
    const artifact = artifactSelection.latestReportsByRunNodeId.get(sourceNode.runNodeId);
    if (!artifact) {
      continue;
    }

    candidateEntries.push({
      artifactId: artifact.id,
      sourceNodeKey: sourceNode.nodeKey,
      sourceRunNodeId: sourceNode.runNodeId,
      sourceAttempt: sourceNode.attempt,
      contentType: artifact.contentType,
      createdAt: artifact.createdAt,
      originalContent: artifact.content,
      sha256: hashContentSha256(artifact.content),
    });
  }

  const includedEntries: ContextEnvelopeEntry[] = [];
  const droppedArtifactIds: number[] = [];
  let remainingChars = MAX_CONTEXT_CHARS_TOTAL;
  let budgetOverflow = false;
  for (const candidate of candidateEntries) {
    if (includedEntries.length >= MAX_UPSTREAM_ARTIFACTS) {
      budgetOverflow = true;
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    const inclusion = resolveIncludedContentForContextCandidate(candidate, remainingChars);
    if (inclusion.budgetOverflow) {
      budgetOverflow = true;
    }
    if (!inclusion.includedContent) {
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    const truncation = buildTruncationMetadata(candidate.originalContent.length, inclusion.includedContent.length);
    includedEntries.push({
      ...candidate,
      includedContent: inclusion.includedContent,
      truncation,
    });
    remainingChars -= inclusion.includedContent.length;
  }

  const contextEntries = includedEntries.map(entry =>
    serializeContextEnvelope({
      workflowRunId: params.workflowRunId,
      targetNodeKey: params.targetNode.nodeKey,
      entry,
    }),
  );

  const hasAnyArtifacts = directPredecessors.some(sourceNode =>
    artifactSelection.runNodeIdsWithAnyArtifacts.has(sourceNode.runNodeId),
  );
  const manifest: ContextHandoffManifest = {
    context_policy_version: CONTEXT_POLICY_VERSION,
    included_artifact_ids: includedEntries.map(entry => entry.artifactId),
    included_source_node_keys: includedEntries.map(entry => entry.sourceNodeKey),
    included_source_run_node_ids: includedEntries.map(entry => entry.sourceRunNodeId),
    included_count: includedEntries.length,
    included_chars_total: includedEntries.reduce((total, entry) => total + entry.truncation.includedChars, 0),
    truncated_artifact_ids: includedEntries
      .filter(entry => entry.truncation.applied)
      .map(entry => entry.artifactId),
    missing_upstream_artifacts: includedEntries.length === 0,
    assembly_timestamp: new Date().toISOString(),
    no_eligible_artifact_types: hasAnyArtifacts && candidateEntries.length === 0,
    budget_overflow: budgetOverflow,
    dropped_artifact_ids: droppedArtifactIds,
  };

  return {
    contextEntries,
    manifest,
  };
}

function createEmptyContextManifest(assemblyTimestamp = new Date().toISOString()): ContextHandoffManifest {
  return {
    context_policy_version: CONTEXT_POLICY_VERSION,
    included_artifact_ids: [],
    included_source_node_keys: [],
    included_source_run_node_ids: [],
    included_count: 0,
    included_chars_total: 0,
    truncated_artifact_ids: [],
    missing_upstream_artifacts: true,
    assembly_timestamp: assemblyTimestamp,
    no_eligible_artifact_types: false,
    budget_overflow: false,
    dropped_artifact_ids: [],
  };
}

function hasPotentialIncomingRoute(
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
  unresolvedDecisionSourceNodeIds: Set<number>,
): boolean {
  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (!sourceNode) {
      return false;
    }

    if (sourceNode.status === 'completed') {
      if (unresolvedDecisionSourceNodeIds.has(edge.sourceNodeId)) {
        return true;
      }
      return selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) === edge.edgeId;
    }

    return sourceNode.status === 'pending' || sourceNode.status === 'running' || sourceNode.status === 'failed';
  });
}

function hasRunnableIncomingRoute(
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
): boolean {
  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      return false;
    }

    return selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) === edge.edgeId;
  });
}

function hasRevisitableIncomingRoute(
  targetNode: RunNodeExecutionRow,
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): boolean {
  const targetArtifactId = latestArtifactsByRunNodeId.get(targetNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;

  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      return false;
    }

    if (selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      return false;
    }

    const sourceArtifactId = latestArtifactsByRunNodeId.get(sourceNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;
    return sourceArtifactId > targetArtifactId;
  });
}

function selectNextRunnableNode(
  rows: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): NextRunnableSelection {
  const latestNodeAttempts = getLatestRunNodeAttempts(rows);
  const routingSelection = buildRoutingSelection(
    latestNodeAttempts,
    edges,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );

  const nextRunnableNode =
    latestNodeAttempts.find((row) => {
      if (row.status !== 'pending' && row.status !== 'completed') {
        return false;
      }

      const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(row.treeNodeId) ?? [];
      if (incomingEdges.length === 0) {
        return row.status === 'pending';
      }

      if (row.status === 'pending') {
        return hasRunnableIncomingRoute(
          incomingEdges,
          routingSelection.latestByTreeNodeId,
          routingSelection.selectedEdgeIdBySourceNodeId,
        );
      }

      if (row.status === 'completed') {
        return hasRevisitableIncomingRoute(
          row,
          incomingEdges,
          routingSelection.latestByTreeNodeId,
          routingSelection.selectedEdgeIdBySourceNodeId,
          latestArtifactsByRunNodeId,
        );
      }

      return false;
    }) ?? null;

  return {
    nextRunnableNode,
    latestNodeAttempts,
    hasNoRouteDecision: routingSelection.hasNoRouteDecision,
    hasUnresolvedDecision: routingSelection.hasUnresolvedDecision,
  };
}

function markUnreachablePendingNodesAsSkipped(
  db: AlphredDatabase,
  workflowRunId: number,
  edgeRows: EdgeRow[],
): void {
  while (true) {
    const latestNodeAttempts = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, workflowRunId));
    const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, workflowRunId);
    const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, workflowRunId);
    const routingSelection = buildRoutingSelection(
      latestNodeAttempts,
      edgeRows,
      routingDecisionSelection.latestByRunNodeId,
      latestArtifactsByRunNodeId,
    );

    const unreachablePendingNode = latestNodeAttempts.find((node) => {
      if (node.status !== 'pending') {
        return false;
      }

      const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(node.treeNodeId) ?? [];
      if (incomingEdges.length === 0) {
        return false;
      }

      return !hasPotentialIncomingRoute(
        incomingEdges,
        routingSelection.latestByTreeNodeId,
        routingSelection.selectedEdgeIdBySourceNodeId,
        routingSelection.unresolvedDecisionSourceNodeIds,
      );
    });

    if (!unreachablePendingNode) {
      return;
    }

    transitionRunNodeStatus(db, {
      runNodeId: unreachablePendingNode.runNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
    });
  }
}

type TokenUsage =
  | {
      mode: 'incremental';
      tokens: number;
    }
  | {
      mode: 'cumulative';
      tokens: number;
    };

type DiagnosticsRedactionState = {
  redacted: boolean;
  truncated: boolean;
};

function toNonNegativeTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function readCumulativeUsage(metadata: Record<string, unknown>): number | undefined {
  const candidates: number[] = [];

  const tokensUsed = toNonNegativeTokenCount(metadata.tokensUsed);
  if (tokensUsed !== undefined) {
    candidates.push(tokensUsed);
  }

  const totalTokens = toNonNegativeTokenCount(metadata.totalTokens);
  if (totalTokens !== undefined) {
    candidates.push(totalTokens);
  }

  const inputTokens = toNonNegativeTokenCount(metadata.inputTokens);
  const outputTokens = toNonNegativeTokenCount(metadata.outputTokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    candidates.push(inputTokens + outputTokens);
  }

  const snakeCaseInputTokens = toNonNegativeTokenCount(metadata.input_tokens);
  const snakeCaseOutputTokens = toNonNegativeTokenCount(metadata.output_tokens);
  if (snakeCaseInputTokens !== undefined && snakeCaseOutputTokens !== undefined) {
    candidates.push(snakeCaseInputTokens + snakeCaseOutputTokens);
  }

  const snakeCaseTotalTokens = toNonNegativeTokenCount(metadata.total_tokens);
  if (snakeCaseTotalTokens !== undefined) {
    candidates.push(snakeCaseTotalTokens);
  }

  if (candidates.length === 0) {
    return undefined;
  }

  return Math.max(...candidates);
}

function readTokenUsageFromMetadata(metadata: Record<string, unknown>): TokenUsage | undefined {
  const cumulativeTokens = readCumulativeUsage(metadata);
  if (cumulativeTokens !== undefined) {
    return {
      mode: 'cumulative',
      tokens: cumulativeTokens,
    };
  }

  const directTokens = toNonNegativeTokenCount(metadata.tokens);
  if (directTokens !== undefined) {
    return {
      mode: 'incremental',
      tokens: directTokens,
    };
  }

  return undefined;
}

function extractTokenUsageFromEvent(event: ProviderEvent): TokenUsage | undefined {
  if (event.type !== 'usage' || !event.metadata) {
    return undefined;
  }

  const topLevelUsage = readTokenUsageFromMetadata(event.metadata);
  const nestedUsage = event.metadata.usage;
  const nestedMetadata = isRecord(nestedUsage) ? nestedUsage : undefined;
  const nestedTokenUsage = nestedMetadata ? readTokenUsageFromMetadata(nestedMetadata) : undefined;

  const cumulativeCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'cumulative' } => usage?.mode === 'cumulative')
    .map(usage => usage.tokens);
  if (cumulativeCandidates.length > 0) {
    return {
      mode: 'cumulative',
      tokens: Math.max(...cumulativeCandidates),
    };
  }

  const incrementalCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'incremental' } => usage?.mode === 'incremental')
    .map(usage => usage.tokens);
  if (incrementalCandidates.length > 0) {
    return {
      mode: 'incremental',
      tokens: Math.max(...incrementalCandidates),
    };
  }

  return undefined;
}

function sanitizeDiagnosticsString(value: string, state: DiagnosticsRedactionState): string {
  if (sensitiveStringPattern.test(value)) {
    state.redacted = true;
    return '[REDACTED]';
  }

  return value;
}

function stringifyRedactedFallback(value: unknown): string {
  switch (typeof value) {
    case 'function':
      return `[Function: ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.description ? `Symbol(${value.description})` : 'Symbol()';
    case 'bigint':
      return `${value.toString()}n`;
    case 'undefined':
      return 'undefined';
    default:
      return JSON.stringify(value);
  }
}

function redactDiagnosticsValue(
  value: unknown,
  state: DiagnosticsRedactionState,
  depth = 0,
): unknown {
  if (depth >= MAX_REDACTION_DEPTH) {
    state.truncated = true;
    return '[MAX_DEPTH_REACHED]';
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeDiagnosticsString(value, state);
  }

  if (Array.isArray(value)) {
    const input = value as unknown[];
    if (input.length > MAX_REDACTION_ARRAY_LENGTH) {
      state.truncated = true;
    }
    return input.slice(0, MAX_REDACTION_ARRAY_LENGTH).map(item => redactDiagnosticsValue(item, state, depth + 1));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => compareStringsByCodeUnit(left, right));
    for (const [key, entryValue] of entries) {
      if (sensitiveMetadataKeyPattern.test(key)) {
        state.redacted = true;
        output[key] = '[REDACTED]';
        continue;
      }

      output[key] = redactDiagnosticsValue(entryValue, state, depth + 1);
    }
    return output;
  }

  return stringifyRedactedFallback(value);
}

function sanitizeDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined,
  state: DiagnosticsRedactionState,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const redactedMetadata = redactDiagnosticsValue(metadata, state);
  const normalizedMetadata = isRecord(redactedMetadata)
    ? redactedMetadata
    : { value: redactedMetadata };
  const serialized = JSON.stringify(normalizedMetadata);
  if (serialized.length <= MAX_DIAGNOSTIC_METADATA_CHARS) {
    return normalizedMetadata;
  }

  state.truncated = true;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: truncateHeadTail(serialized, MAX_DIAGNOSTIC_METADATA_CHARS),
  };
}

function extractToolName(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }

  const candidates = [metadata.toolName, metadata.tool_name, metadata.tool, metadata.name, metadata.command];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function summarizeToolEventContent(
  event: DiagnosticEvent,
  toolName: string | null,
): string {
  const preview = event.contentPreview.trim();
  if (preview.length > 0) {
    return preview;
  }

  if (toolName) {
    return `${event.type} event for ${toolName}`;
  }

  return `${event.type} event`;
}

function classifyDiagnosticError(error: unknown): DiagnosticErrorDetails['classification'] {
  const normalizedError = unwrapDiagnosticError(error);
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes('without a result event')) {
    return 'provider_result_missing';
  }

  if (message.includes('timeout')) {
    return 'timeout';
  }

  if (
    (normalizedError instanceof Error && normalizedError.name.toLowerCase().includes('abort')) ||
    message.includes('aborted')
  ) {
    return 'aborted';
  }

  return 'unknown';
}

function toDiagnosticErrorDetails(error: unknown, state: DiagnosticsRedactionState): DiagnosticErrorDetails {
  const normalizedError = unwrapDiagnosticError(error);
  const name = normalizedError instanceof Error ? sanitizeDiagnosticsString(normalizedError.name, state) : 'Error';
  const message = sanitizeDiagnosticsString(toErrorMessage(error), state);
  const stackPreview =
    normalizedError instanceof Error && typeof normalizedError.stack === 'string'
      ? truncateHeadTail(sanitizeDiagnosticsString(normalizedError.stack, state), MAX_DIAGNOSTIC_ERROR_STACK_CHARS)
      : null;
  if (stackPreview !== null && stackPreview.length >= MAX_DIAGNOSTIC_ERROR_STACK_CHARS) {
    state.truncated = true;
  }

  return {
    name,
    message,
    classification: classifyDiagnosticError(error),
    stackPreview,
  };
}

function buildDiagnosticEvents(
  events: ProviderEvent[],
  state: DiagnosticsRedactionState,
): {
  eventCount: number;
  retainedEvents: DiagnosticEvent[];
  droppedEventCount: number;
  eventTypeCounts: Partial<Record<ProviderEventType, number>>;
} {
  const eventTypeCounts: Partial<Record<ProviderEventType, number>> = {};
  const diagnosticEvents: DiagnosticEvent[] = [];
  let cumulativeTokens: number | null = null;

  for (const [eventIndex, event] of events.entries()) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;

    const normalizedContent = sanitizeDiagnosticsString(event.content, state);
    const contentPreview = truncateHeadTail(normalizedContent, MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS);
    if (contentPreview.length < normalizedContent.length) {
      state.truncated = true;
    }

    const metadata = sanitizeDiagnosticMetadata(event.metadata, state);
    const tokenUsage = extractTokenUsageFromEvent(event);
    let usage: DiagnosticUsageSnapshot | null = null;
    if (tokenUsage) {
      if (tokenUsage.mode === 'incremental') {
        const nextCumulativeTokens: number = (cumulativeTokens ?? 0) + tokenUsage.tokens;
        cumulativeTokens = nextCumulativeTokens;
        usage = {
          deltaTokens: tokenUsage.tokens,
          cumulativeTokens: nextCumulativeTokens,
        };
      } else {
        const previous = cumulativeTokens;
        cumulativeTokens = tokenUsage.tokens;
        usage = {
          deltaTokens: previous === null ? null : Math.max(tokenUsage.tokens - previous, 0),
          cumulativeTokens: tokenUsage.tokens,
        };
      }
    }

    diagnosticEvents.push({
      eventIndex,
      type: event.type,
      timestamp: event.timestamp,
      contentChars: event.content.length,
      contentPreview,
      metadata,
      usage,
    });
  }

  const retainedEvents = diagnosticEvents.slice(0, MAX_DIAGNOSTIC_EVENTS);
  const droppedEventCount = Math.max(diagnosticEvents.length - retainedEvents.length, 0);
  if (droppedEventCount > 0) {
    state.truncated = true;
  }

  return {
    eventCount: diagnosticEvents.length,
    retainedEvents,
    droppedEventCount,
    eventTypeCounts,
  };
}

function resolveNextRunNodeStreamSequence(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
  },
): number {
  const latestEvent = db
    .select({
      sequence: runNodeStreamEvents.sequence,
    })
    .from(runNodeStreamEvents)
    .where(
      and(
        eq(runNodeStreamEvents.workflowRunId, params.workflowRunId),
        eq(runNodeStreamEvents.runNodeId, params.runNodeId),
        eq(runNodeStreamEvents.attempt, params.attempt),
      ),
    )
    .orderBy(desc(runNodeStreamEvents.sequence), desc(runNodeStreamEvents.id))
    .limit(1)
    .get();

  return (latestEvent?.sequence ?? 0) + 1;
}

function persistRunNodeStreamEvent(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    sequence: number;
    event: ProviderEvent;
    usageState: StreamUsageState;
  },
): void {
  const state: DiagnosticsRedactionState = {
    redacted: false,
    truncated: false,
  };
  const normalizedContent = sanitizeDiagnosticsString(params.event.content, state);
  const contentPreview = truncateHeadTail(normalizedContent, MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS);
  if (contentPreview.length < normalizedContent.length) {
    state.truncated = true;
  }

  const metadata = sanitizeDiagnosticMetadata(params.event.metadata, state);
  let usageDeltaTokens: number | null = null;
  let usageCumulativeTokens: number | null = null;
  const tokenUsage = extractTokenUsageFromEvent(params.event);
  if (tokenUsage) {
    if (tokenUsage.mode === 'incremental') {
      usageDeltaTokens = tokenUsage.tokens;
      usageCumulativeTokens = (params.usageState.cumulativeTokens ?? 0) + tokenUsage.tokens;
      params.usageState.cumulativeTokens = usageCumulativeTokens;
    } else {
      usageDeltaTokens =
        params.usageState.cumulativeTokens === null
          ? null
          : Math.max(tokenUsage.tokens - params.usageState.cumulativeTokens, 0);
      usageCumulativeTokens = tokenUsage.tokens;
      params.usageState.cumulativeTokens = tokenUsage.tokens;
    }
  }

  db.insert(runNodeStreamEvents)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      attempt: params.attempt,
      sequence: params.sequence,
      eventType: params.event.type,
      timestamp: params.event.timestamp,
      contentChars: params.event.content.length,
      contentPreview,
      metadata,
      usageDeltaTokens,
      usageCumulativeTokens,
    })
    .run();
}

function buildToolEventSummaries(events: DiagnosticEvent[]): DiagnosticToolEvent[] {
  const summaries: DiagnosticToolEvent[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use' && event.type !== 'tool_result') {
      continue;
    }

    const toolName = extractToolName(event.metadata);
    summaries.push({
      eventIndex: event.eventIndex,
      type: event.type,
      timestamp: event.timestamp,
      toolName,
      summary: summarizeToolEventContent(event, toolName),
    });
  }

  return summaries;
}

function buildDiagnosticsPayload(params: {
  workflowRunId: number;
  node: RunNodeExecutionRow;
  attempt: number;
  outcome: 'completed' | 'failed';
  status: 'completed' | 'failed';
  runNodeSnapshot: RunNodeExecutionRow;
  contextManifest: ContextHandoffManifest;
  tokensUsed: number;
  events: ProviderEvent[];
  routingDecision: RouteDecisionSignal | null;
  error: unknown;
}): {
  payload: RunNodeDiagnosticsPayload;
  payloadChars: number;
  redacted: boolean;
  truncated: boolean;
  eventCount: number;
  retainedEventCount: number;
  droppedEventCount: number;
} {
  const redactionState: DiagnosticsRedactionState = {
    redacted: false,
    truncated: false,
  };
  const persistedAt = new Date().toISOString();
  const eventBuild = buildDiagnosticEvents(params.events, redactionState);
  let retainedEvents = eventBuild.retainedEvents;
  let droppedEventCount = eventBuild.droppedEventCount;
  let toolEvents = buildToolEventSummaries(retainedEvents);
  let errorDetails = params.error === null ? null : toDiagnosticErrorDetails(params.error, redactionState);

  const buildPayload = (): RunNodeDiagnosticsPayload => ({
    schemaVersion: RUN_NODE_DIAGNOSTICS_SCHEMA_VERSION,
    workflowRunId: params.workflowRunId,
    runNodeId: params.node.runNodeId,
    nodeKey: params.node.nodeKey,
    attempt: params.attempt,
    outcome: params.outcome,
    status: params.status,
    provider: params.node.provider,
    timing: {
      queuedAt: params.node.createdAt ?? null,
      startedAt: params.runNodeSnapshot.startedAt,
      completedAt: params.status === 'completed' ? params.runNodeSnapshot.completedAt : null,
      failedAt: params.status === 'failed' ? params.runNodeSnapshot.completedAt : null,
      persistedAt,
    },
    summary: {
      tokensUsed: params.tokensUsed,
      eventCount: eventBuild.eventCount,
      retainedEventCount: retainedEvents.length,
      droppedEventCount,
      toolEventCount: toolEvents.length,
      redacted: redactionState.redacted,
      truncated: redactionState.truncated,
    },
    contextHandoff: params.contextManifest,
    eventTypeCounts: eventBuild.eventTypeCounts,
    events: retainedEvents,
    toolEvents,
    routingDecision: params.routingDecision,
    error: errorDetails,
  });

  let payload = buildPayload();
  let payloadChars = JSON.stringify(payload).length;
  while (payloadChars > MAX_DIAGNOSTIC_PAYLOAD_CHARS && retainedEvents.length > 0) {
    retainedEvents = retainedEvents.slice(0, -1);
    droppedEventCount += 1;
    toolEvents = buildToolEventSummaries(retainedEvents);
    redactionState.truncated = true;
    payload = buildPayload();
    payloadChars = JSON.stringify(payload).length;
  }

  if (payloadChars > MAX_DIAGNOSTIC_PAYLOAD_CHARS && errorDetails?.stackPreview) {
    errorDetails = {
      ...errorDetails,
      stackPreview: null,
    };
    redactionState.truncated = true;
    payload = buildPayload();
    payloadChars = JSON.stringify(payload).length;
  }

  payload.summary.redacted = redactionState.redacted;
  payload.summary.truncated = redactionState.truncated;
  payload.summary.retainedEventCount = retainedEvents.length;
  payload.summary.droppedEventCount = droppedEventCount;
  payload.summary.toolEventCount = toolEvents.length;
  payload.error = errorDetails;
  payloadChars = JSON.stringify(payload).length;

  return {
    payload,
    payloadChars,
    redacted: redactionState.redacted,
    truncated: redactionState.truncated,
    eventCount: eventBuild.eventCount,
    retainedEventCount: retainedEvents.length,
    droppedEventCount,
  };
}

function persistRunNodeAttemptDiagnostics(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    node: RunNodeExecutionRow;
    attempt: number;
    outcome: 'completed' | 'failed';
    status: 'completed' | 'failed';
    runNodeSnapshot: RunNodeExecutionRow;
    contextManifest: ContextHandoffManifest;
    tokensUsed: number;
    events: ProviderEvent[];
    routingDecision: RouteDecisionSignal | null;
    error: unknown;
  },
): void {
  const diagnostics = buildDiagnosticsPayload(params);

  db.insert(runNodeDiagnostics)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.node.runNodeId,
      attempt: params.attempt,
      outcome: params.outcome,
      eventCount: diagnostics.eventCount,
      retainedEventCount: diagnostics.retainedEventCount,
      droppedEventCount: diagnostics.droppedEventCount,
      redacted: diagnostics.redacted ? 1 : 0,
      truncated: diagnostics.truncated ? 1 : 0,
      payloadChars: diagnostics.payloadChars,
      diagnostics: diagnostics.payload,
    })
    .onConflictDoNothing({
      target: [runNodeDiagnostics.workflowRunId, runNodeDiagnostics.runNodeId, runNodeDiagnostics.attempt],
    })
    .run();
}

function unwrapDiagnosticError(error: unknown): unknown {
  if (error instanceof PhaseRunError && error.cause !== undefined) {
    return error.cause;
  }

  return error;
}

function toErrorMessage(error: unknown): string {
  const candidate = unwrapDiagnosticError(error);
  if (candidate instanceof Error) {
    return candidate.message;
  }

  return String(candidate);
}

function isRunNodeClaimPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Run-node transition precondition failed') ||
      error.message.startsWith('Run-node revisit claim precondition failed'))
  );
}

function isWorkflowRunTransitionPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Workflow-run transition precondition failed');
}

function isRunNodeRetryQueuePreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Run-node retry requeue precondition failed');
}

function isRetryControlPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Workflow-run retry control precondition failed');
}

function createWorkflowRunControlResult(
  params: {
    action: WorkflowRunControlAction;
    outcome: 'applied' | 'noop';
    workflowRunId: number;
    previousRunStatus: WorkflowRunStatus;
    runStatus: WorkflowRunStatus;
    retriedRunNodeIds?: number[];
  },
): WorkflowRunControlResult {
  return {
    action: params.action,
    outcome: params.outcome,
    workflowRunId: params.workflowRunId,
    previousRunStatus: params.previousRunStatus,
    runStatus: params.runStatus,
    retriedRunNodeIds: params.retriedRunNodeIds ?? [],
  };
}

function createInvalidControlTransitionError(
  params: {
    action: WorkflowRunControlAction;
    workflowRunId: number;
    runStatus: WorkflowRunStatus;
    message: string;
  },
): WorkflowRunControlError {
  return new WorkflowRunControlError(
    'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
    params.message,
    {
      action: params.action,
      workflowRunId: params.workflowRunId,
      runStatus: params.runStatus,
    },
  );
}

function createConcurrentControlConflictError(
  params: {
    action: WorkflowRunControlAction;
    workflowRunId: number;
    runStatus: WorkflowRunStatus;
    message: string;
    cause?: unknown;
  },
): WorkflowRunControlError {
  return new WorkflowRunControlError(
    'WORKFLOW_RUN_CONTROL_CONCURRENT_CONFLICT',
    params.message,
    {
      action: params.action,
      workflowRunId: params.workflowRunId,
      runStatus: params.runStatus,
      cause: params.cause,
    },
  );
}

function createRetryTargetsNotFoundError(
  params: {
    action: 'retry';
    workflowRunId: number;
    runStatus: WorkflowRunStatus;
    message: string;
  },
): WorkflowRunControlError {
  return new WorkflowRunControlError(
    'WORKFLOW_RUN_CONTROL_RETRY_TARGETS_NOT_FOUND',
    params.message,
    {
      action: params.action,
      workflowRunId: params.workflowRunId,
      runStatus: params.runStatus,
    },
  );
}

function transitionRunTo(
  db: AlphredDatabase,
  runId: number,
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  occurredAt?: string,
): WorkflowRunStatus {
  if (from === to) {
    return from;
  }

  if (to === 'running') {
    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: from,
      to: 'running',
      occurredAt,
    });
    return 'running';
  }

  if (to === 'completed' || to === 'failed' || to === 'cancelled') {
    let current = from;
    if (current === 'pending' || current === 'paused') {
      transitionWorkflowRunStatus(db, {
        workflowRunId: runId,
        expectedFrom: current,
        to: 'running',
        occurredAt,
      });
      current = 'running';
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: runId,
      expectedFrom: current,
      to,
      occurredAt,
    });
    return to;
  }

  transitionWorkflowRunStatus(db, {
    workflowRunId: runId,
    expectedFrom: from,
    to,
    occurredAt,
  });
  return to;
}

function transitionRunToCurrentForExecutor(
  db: AlphredDatabase,
  runId: number,
  desiredStatus: WorkflowRunStatus,
): WorkflowRunStatus {
  for (let attempt = 0; attempt < MAX_CONTROL_PRECONDITION_RETRIES; attempt += 1) {
    const currentStatus = loadWorkflowRunRow(db, runId).status;
    if (currentStatus === desiredStatus) {
      return currentStatus;
    }

    if (isTerminalWorkflowRunStatus(currentStatus)) {
      return currentStatus;
    }

    // Preserve externally requested pause while executor computes running state
    // from node topology between node boundaries.
    if (currentStatus === 'paused' && desiredStatus === 'running') {
      return currentStatus;
    }

    try {
      return transitionRunTo(db, runId, currentStatus, desiredStatus);
    } catch (error) {
      if (isWorkflowRunTransitionPreconditionFailure(error)) {
        continue;
      }
      throw error;
    }
  }

  return loadWorkflowRunRow(db, runId).status;
}

function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): status is TerminalWorkflowRunStatus {
  return runTerminalStatuses.has(status);
}

async function notifyRunTerminalTransition(
  dependencies: SqlWorkflowExecutorDependencies,
  params: {
    workflowRunId: number;
    previousRunStatus: WorkflowRunStatus;
    nextRunStatus: WorkflowRunStatus;
  },
): Promise<void> {
  if (dependencies.onRunTerminal === undefined) {
    return;
  }

  if (isTerminalWorkflowRunStatus(params.previousRunStatus)) {
    return;
  }

  if (!isTerminalWorkflowRunStatus(params.nextRunStatus)) {
    return;
  }

  await dependencies.onRunTerminal({
    workflowRunId: params.workflowRunId,
    runStatus: params.nextRunStatus,
  });
}

function resolveRunStatusFromNodes(latestNodeAttempts: RunNodeExecutionRow[]): WorkflowRunStatus {
  if (latestNodeAttempts.some(node => node.status === 'failed')) {
    return 'failed';
  }

  if (latestNodeAttempts.some(node => node.status === 'running')) {
    return 'running';
  }

  if (latestNodeAttempts.some(node => node.status === 'pending')) {
    return 'running';
  }

  return 'completed';
}

function createExecutionPhase(node: RunNodeExecutionRow): PhaseDefinition {
  if (node.nodeType !== 'agent') {
    throw new Error(`Unsupported node type "${node.nodeType}" for run node "${node.nodeKey}".`);
  }

  return {
    name: node.nodeKey,
    type: 'agent',
    provider: (node.provider as AgentProviderName | null) ?? undefined,
    model: node.model ?? undefined,
    prompt: node.prompt ?? '',
    transitions: [],
  };
}

function loadWorkflowRunRow(db: AlphredDatabase, workflowRunId: number): WorkflowRunRow {
  const run = db
    .select({
      id: workflowRuns.id,
      workflowTreeId: workflowRuns.workflowTreeId,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, workflowRunId))
    .get();

  if (!run) {
    throw new Error(`Workflow run id=${workflowRunId} was not found.`);
  }

  return {
    id: run.id,
    workflowTreeId: run.workflowTreeId,
    status: toWorkflowRunStatus(run.status),
  };
}

function loadRunNodeExecutionRows(db: AlphredDatabase, workflowRunId: number): RunNodeExecutionRow[] {
  const rows = db
    .select({
      runNodeId: runNodes.id,
      treeNodeId: runNodes.treeNodeId,
      nodeKey: runNodes.nodeKey,
      status: runNodes.status,
      sequenceIndex: runNodes.sequenceIndex,
      attempt: runNodes.attempt,
      createdAt: runNodes.createdAt,
      startedAt: runNodes.startedAt,
      completedAt: runNodes.completedAt,
      maxRetries: treeNodes.maxRetries,
      nodeType: treeNodes.nodeType,
      provider: treeNodes.provider,
      model: treeNodes.model,
      executionPermissions: treeNodes.executionPermissions,
      prompt: promptTemplates.content,
      promptContentType: promptTemplates.contentType,
    })
    .from(runNodes)
    .innerJoin(treeNodes, eq(runNodes.treeNodeId, treeNodes.id))
    .leftJoin(promptTemplates, eq(treeNodes.promptTemplateId, promptTemplates.id))
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.nodeKey), asc(runNodes.attempt), asc(runNodes.id))
    .all();

  return rows.map(row => ({
    runNodeId: row.runNodeId,
    treeNodeId: row.treeNodeId,
    nodeKey: row.nodeKey,
    status: toRunNodeStatus(row.status),
    sequenceIndex: row.sequenceIndex,
    attempt: row.attempt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    maxRetries: row.maxRetries,
    nodeType: row.nodeType,
    provider: row.provider,
    model: row.model,
    executionPermissions: row.executionPermissions,
    prompt: row.prompt,
    promptContentType: row.promptContentType,
  }));
}

function loadRunNodeExecutionRowById(
  db: AlphredDatabase,
  workflowRunId: number,
  runNodeId: number,
): RunNodeExecutionRow {
  const row = loadRunNodeExecutionRows(db, workflowRunId).find(node => node.runNodeId === runNodeId);
  if (!row) {
    throw new Error(`Run node id=${runNodeId} was not found for workflow run id=${workflowRunId}.`);
  }

  return row;
}

function loadEdgeRows(db: AlphredDatabase, workflowTreeId: number): EdgeRow[] {
  return db
    .select({
      edgeId: treeEdges.id,
      sourceNodeId: treeEdges.sourceNodeId,
      targetNodeId: treeEdges.targetNodeId,
      priority: treeEdges.priority,
      auto: treeEdges.auto,
      guardExpression: guardDefinitions.expression,
    })
    .from(treeEdges)
    .leftJoin(guardDefinitions, eq(treeEdges.guardDefinitionId, guardDefinitions.id))
    .where(eq(treeEdges.workflowTreeId, workflowTreeId))
    .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
    .all();
}

function persistRoutingDecision(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    decisionType: RoutingDecisionType;
    rationale?: string;
    rawOutput?: Record<string, unknown>;
  },
): void {
  db.insert(routingDecisions)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: params.decisionType,
      rationale: params.rationale ?? null,
      rawOutput: params.rawOutput ?? null,
    })
    .run();
}

function persistCompletedNodeRoutingDecision(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    treeNodeId: number;
    attempt: number;
    routingDecision: RouteDecisionSignal | null;
    edgeRows: EdgeRow[];
  },
): CompletedNodeRoutingOutcome {
  const decisionSignal = params.routingDecision;
  const outgoingEdges = params.edgeRows.filter(edge => edge.sourceNodeId === params.treeNodeId);

  if (outgoingEdges.length === 0) {
    if (!decisionSignal) {
      return {
        decisionType: null,
        selectedEdgeId: null,
      };
    }

    persistRoutingDecision(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: decisionSignal,
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: decisionSignal,
        attempt: params.attempt,
      },
    });
    return {
      decisionType: decisionSignal,
      selectedEdgeId: null,
    };
  }

  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decisionSignal);
  if (matchingEdge) {
    if (!decisionSignal) {
      return {
        decisionType: null,
        selectedEdgeId: matchingEdge.edgeId,
      };
    }

    persistRoutingDecision(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: decisionSignal,
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: decisionSignal,
        selectedEdgeId: matchingEdge.edgeId,
        attempt: params.attempt,
      },
    });
    return {
      decisionType: decisionSignal,
      selectedEdgeId: matchingEdge.edgeId,
    };
  }

  persistRoutingDecision(db, {
    workflowRunId: params.workflowRunId,
    runNodeId: params.runNodeId,
    decisionType: 'no_route',
    rationale: `No outgoing edge matched for tree_node_id=${params.treeNodeId}.`,
    rawOutput: {
      source: 'provider_result_metadata',
      routingDecision: decisionSignal,
      outgoingEdgeIds: outgoingEdges.map(edge => edge.edgeId),
      attempt: params.attempt,
    },
  });

  return {
    decisionType: 'no_route',
    selectedEdgeId: null,
  };
}

function persistSuccessArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    content: string;
    contentType: string | null;
    metadata: Record<string, unknown>;
  },
): number {
  const artifact = db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      artifactType: 'report',
      contentType: normalizeArtifactContentType(params.contentType),
      content: params.content,
      metadata: params.metadata,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

function persistFailureArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    content: string;
    metadata: Record<string, unknown>;
  },
): number {
  const artifact = db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      artifactType: 'log',
      contentType: 'text',
      content: params.content,
      metadata: params.metadata,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

function shouldRetryNodeAttempt(attempt: number, maxRetries: number): boolean {
  return attempt <= maxRetries;
}

function transitionFailedRunNodeToRetryAttempt(
  db: AlphredDatabase,
  params: {
    runNodeId: number;
    currentAttempt: number;
    nextAttempt: number;
  },
): void {
  const occurredAt = new Date().toISOString();
  transitionRunNodeStatus(db, {
    runNodeId: params.runNodeId,
    expectedFrom: 'failed',
    to: 'running',
    occurredAt,
  });

  const updated = db
    .update(runNodes)
    .set({
      attempt: params.nextAttempt,
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(runNodes.id, params.runNodeId),
        eq(runNodes.status, 'running'),
        eq(runNodes.attempt, params.currentAttempt),
      ),
    )
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node retry attempt update precondition failed for id=${params.runNodeId}; expected attempt=${params.currentAttempt}.`,
    );
  }
}

function transitionFailedRunNodeToPendingAttempt(
  db: Pick<AlphredDatabase, 'update'>,
  params: {
    runNodeId: number;
    currentAttempt: number;
    nextAttempt: number;
  },
): void {
  // Operator-triggered retry requeues failed nodes without eagerly claiming
  // execution so normal scheduling can resume deterministically.
  const occurredAt = new Date().toISOString();
  const updated = db
    .update(runNodes)
    .set({
      status: 'pending',
      attempt: params.nextAttempt,
      startedAt: null,
      completedAt: null,
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(runNodes.id, params.runNodeId),
        eq(runNodes.status, 'failed'),
        eq(runNodes.attempt, params.currentAttempt),
      ),
    )
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node retry requeue precondition failed for id=${params.runNodeId}; expected status "failed" and attempt=${params.currentAttempt}.`,
    );
  }
}

function transitionCompletedRunNodeToPendingAttempt(
  db: AlphredDatabase,
  params: {
    runNodeId: number;
    currentAttempt: number;
    nextAttempt: number;
  },
): void {
  // Requeue completed nodes through this helper so status reset and attempt
  // increment remain coupled in one atomic update.
  const occurredAt = new Date().toISOString();
  const updated = db
    .update(runNodes)
    .set({
      status: 'pending',
      attempt: params.nextAttempt,
      startedAt: null,
      completedAt: null,
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(runNodes.id, params.runNodeId),
        eq(runNodes.status, 'completed'),
        eq(runNodes.attempt, params.currentAttempt),
      ),
    )
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node revisit claim precondition failed for id=${params.runNodeId}; expected status "completed" and attempt=${params.currentAttempt}.`,
    );
  }
}

function reactivateSelectedTargetNode(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    selectedEdgeId: number | null;
    edgeRows: EdgeRow[];
  },
): void {
  if (params.selectedEdgeId === null) {
    return;
  }

  const selectedEdge = params.edgeRows.find(edge => edge.edgeId === params.selectedEdgeId);
  if (!selectedEdge) {
    throw new Error(`Selected edge id=${params.selectedEdgeId} was not found in workflow topology.`);
  }

  const targetNode = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, params.workflowRunId)).find(
    node => node.treeNodeId === selectedEdge.targetNodeId,
  );

  if (!targetNode || targetNode.status === 'pending' || targetNode.status === 'running') {
    return;
  }

  if (targetNode.status === 'completed') {
    transitionCompletedRunNodeToPendingAttempt(db, {
      runNodeId: targetNode.runNodeId,
      currentAttempt: targetNode.attempt,
      nextAttempt: targetNode.attempt + 1,
    });
    return;
  }

  if (targetNode.status === 'skipped') {
    transitionRunNodeStatus(db, {
      runNodeId: targetNode.runNodeId,
      expectedFrom: 'skipped',
      to: 'pending',
    });
  }
}

function failRunOnIterationLimit(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  params: {
    maxSteps: number;
    executedNodes: number;
  },
): WorkflowRunStatus {
  const message = `Execution loop exceeded maxSteps=${params.maxSteps} for workflow run id=${run.id} (status=${run.status}).`;
  const runNodeRows = loadRunNodeExecutionRows(db, run.id);
  const edgeRows = loadEdgeRows(db, run.workflowTreeId);
  const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
  const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, run.id);
  const { nextRunnableNode, latestNodeAttempts } = selectNextRunnableNode(
    runNodeRows,
    edgeRows,
    routingDecisionSelection.latestByRunNodeId,
    latestArtifactsByRunNodeId,
  );

  const targetedNode =
    nextRunnableNode ??
    latestNodeAttempts.find(node => node.status === 'running') ??
    latestNodeAttempts[latestNodeAttempts.length - 1] ??
    null;

  if (targetedNode) {
    let status = targetedNode.status;
    if (status === 'pending') {
      transitionRunNodeStatus(db, {
        runNodeId: targetedNode.runNodeId,
        expectedFrom: 'pending',
        to: 'running',
      });
      status = 'running';
    }

    persistFailureArtifact(db, {
      workflowRunId: run.id,
      runNodeId: targetedNode.runNodeId,
      content: message,
      metadata: {
        success: false,
        provider: targetedNode.provider,
        nodeKey: targetedNode.nodeKey,
        attempt: targetedNode.attempt,
        maxRetries: targetedNode.maxRetries,
        failureReason: 'iteration_limit_exceeded',
        limitType: 'max_steps',
        maxSteps: params.maxSteps,
        executedNodes: params.executedNodes,
      },
    });

    if (status === 'running') {
      transitionRunNodeStatus(db, {
        runNodeId: targetedNode.runNodeId,
        expectedFrom: 'running',
        to: 'failed',
      });
    }

    const persistedTargetNode = loadRunNodeExecutionRowById(db, run.id, targetedNode.runNodeId);
    const diagnosticStatus: 'completed' | 'failed' = persistedTargetNode.status === 'completed' ? 'completed' : 'failed';
    persistRunNodeAttemptDiagnostics(db, {
      workflowRunId: run.id,
      node: targetedNode,
      attempt: targetedNode.attempt,
      outcome: 'failed',
      status: diagnosticStatus,
      runNodeSnapshot: persistedTargetNode,
      contextManifest: createEmptyContextManifest(),
      tokensUsed: 0,
      events: [],
      routingDecision: null,
      error: new Error(message),
    });
  }

  return transitionRunToCurrentForExecutor(db, run.id, 'failed');
}

function resolveNoRunnableOutcome(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  latestNodeAttempts: RunNodeExecutionRow[],
  hasNoRouteDecision: boolean,
  hasUnresolvedDecision: boolean,
): ExecuteNextRunnableNodeResult {
  const hasPending = latestNodeAttempts.some(node => node.status === 'pending');
  const hasRunning = latestNodeAttempts.some(node => node.status === 'running');
  const hasTerminalFailure = latestNodeAttempts.some(node => node.status === 'failed');

  if (hasNoRouteDecision || hasUnresolvedDecision) {
    const runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
    return {
      outcome: 'blocked',
      workflowRunId: run.id,
      runStatus,
    };
  }

  if (!hasPending && !hasRunning) {
    const resolvedRunStatus = hasTerminalFailure ? 'failed' : 'completed';
    const runStatus = transitionRunToCurrentForExecutor(db, run.id, resolvedRunStatus);
    return {
      outcome: 'no_runnable',
      workflowRunId: run.id,
      runStatus,
    };
  }

  if (hasTerminalFailure) {
    const runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
    return {
      outcome: 'blocked',
      workflowRunId: run.id,
      runStatus,
    };
  }

  const runStatus = transitionRunToCurrentForExecutor(db, run.id, 'running');
  return {
    outcome: 'blocked',
    workflowRunId: run.id,
    runStatus,
  };
}

function ensureRunIsRunning(db: AlphredDatabase, run: WorkflowRunRow): WorkflowRunStatus {
  return transitionRunToCurrentForExecutor(db, run.id, 'running');
}

function claimRunnableNode(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
): ExecuteNextRunnableNodeResult | null {
  try {
    if (node.status === 'pending') {
      transitionRunNodeStatus(db, {
        runNodeId: node.runNodeId,
        expectedFrom: 'pending',
        to: 'running',
      });
    } else if (node.status === 'completed') {
      transitionCompletedRunNodeToPendingAttempt(db, {
        runNodeId: node.runNodeId,
        currentAttempt: node.attempt,
        nextAttempt: node.attempt + 1,
      });
      transitionRunNodeStatus(db, {
        runNodeId: node.runNodeId,
        expectedFrom: 'pending',
        to: 'running',
      });
    } else {
      throw new Error(
        `Run node id=${node.runNodeId} is not claimable from status "${node.status}".`,
      );
    }
  } catch (error) {
    if (isRunNodeClaimPreconditionFailure(error)) {
      const refreshedRun = loadWorkflowRunRow(db, run.id);
      return {
        outcome: 'blocked',
        workflowRunId: run.id,
        runStatus: refreshedRun.status,
      };
    }
    throw error;
  }

  return null;
}

type ClaimedNodeSuccess = {
  artifactId: number;
  runStatus: WorkflowRunStatus;
};

type ClaimedNodeSuccessParams = {
  currentAttempt: number;
  currentRunStatus: WorkflowRunStatus;
  contextManifest: ContextHandoffManifest;
  phaseResult: Awaited<ReturnType<typeof runPhase>>;
};

type ClaimedNodeFailure = {
  artifactId: number;
  runStatus: WorkflowRunStatus;
  runNodeStatus: 'completed' | 'failed';
  nextAttempt: number | null;
  nextStepOutcome: Extract<ExecuteNextRunnableNodeResult, { outcome: 'blocked' | 'run_terminal' }>['outcome'] | null;
};

type ClaimedNodeFailureParams = {
  currentAttempt: number;
  contextManifest: ContextHandoffManifest;
  failureEvents: ProviderEvent[];
  failureTokensUsed: number;
  error: unknown;
};

type NodeFailureReason = 'post_completion_failure' | 'retry_scheduled' | 'retry_limit_exceeded';

function buildExecutedNodeResult(
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  runNodeStatus: 'completed' | 'failed',
  runStatus: WorkflowRunStatus,
  artifactId: number,
): ExecuteNextRunnableNodeResult {
  return {
    outcome: 'executed',
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    nodeKey: node.nodeKey,
    runNodeStatus,
    runStatus,
    artifactId,
  };
}

function resolveFailureReason(persistedNodeStatus: RunNodeStatus, canRetry: boolean): NodeFailureReason {
  if (persistedNodeStatus === 'completed') {
    return 'post_completion_failure';
  }

  if (canRetry) {
    return 'retry_scheduled';
  }

  return 'retry_limit_exceeded';
}

async function executeNodePhase(
  node: RunNodeExecutionRow,
  options: ProviderRunOptions,
  upstreamContextEntries: string[],
  dependencies: SqlWorkflowExecutorDependencies,
  onEvent?: (event: ProviderEvent) => Promise<void>,
): Promise<Awaited<ReturnType<typeof runPhase>>> {
  const phase = createExecutionPhase(node);
  const optionsWithContext =
    upstreamContextEntries.length === 0
      ? options
      : {
          ...options,
          context: [...(options.context ?? []), ...upstreamContextEntries],
        };
  const nodeExecutionPermissions = normalizeRunNodeExecutionPermissions(node.executionPermissions, node.nodeKey);
  const mergedExecutionPermissions = mergeExecutionPermissions(
    optionsWithContext.executionPermissions,
    nodeExecutionPermissions,
  );
  const optionsWithExecutionPermissions =
    mergedExecutionPermissions === undefined
      ? optionsWithContext
      : {
          ...optionsWithContext,
          executionPermissions: mergedExecutionPermissions,
        };
  const phaseOptions = phase.model
    ? { ...optionsWithExecutionPermissions, model: phase.model }
    : optionsWithExecutionPermissions;
  return runPhase(phase, phaseOptions, {
    resolveProvider: dependencies.resolveProvider,
    onEvent,
  });
}

function handleClaimedNodeSuccess(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  edgeRows: EdgeRow[],
  params: ClaimedNodeSuccessParams,
): ClaimedNodeSuccess {
  const { currentAttempt, currentRunStatus, contextManifest, phaseResult } = params;

  const artifactId = persistSuccessArtifact(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    content: phaseResult.report,
    contentType: node.promptContentType,
    metadata: {
      success: true,
      provider: node.provider,
      nodeKey: node.nodeKey,
      attempt: currentAttempt,
      maxRetries: node.maxRetries,
      retriesUsed: Math.max(currentAttempt - 1, 0),
      tokensUsed: phaseResult.tokensUsed,
      eventCount: phaseResult.events.length,
      ...contextManifest,
    },
  });

  const routingOutcome = persistCompletedNodeRoutingDecision(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    treeNodeId: node.treeNodeId,
    attempt: currentAttempt,
    routingDecision: phaseResult.routingDecision,
    edgeRows,
  });

  transitionRunNodeStatus(db, {
    runNodeId: node.runNodeId,
    expectedFrom: 'running',
    to: 'completed',
  });

  const persistedNode = loadRunNodeExecutionRowById(db, run.id, node.runNodeId);
  persistRunNodeAttemptDiagnostics(db, {
    workflowRunId: run.id,
    node,
    attempt: currentAttempt,
    outcome: 'completed',
    status: 'completed',
    runNodeSnapshot: persistedNode,
    contextManifest,
    tokensUsed: phaseResult.tokensUsed,
    events: phaseResult.events,
    routingDecision: phaseResult.routingDecision,
    error: null,
  });

  let runStatus = currentRunStatus;
  if (routingOutcome.decisionType === 'no_route') {
    runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
  } else {
    reactivateSelectedTargetNode(db, {
      workflowRunId: run.id,
      selectedEdgeId: routingOutcome.selectedEdgeId,
      edgeRows,
    });
    markUnreachablePendingNodesAsSkipped(db, run.id, edgeRows);
    const latestAfterSuccess = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
    const targetRunStatus = resolveRunStatusFromNodes(latestAfterSuccess);
    runStatus = transitionRunToCurrentForExecutor(db, run.id, targetRunStatus);
  }

  return {
    artifactId,
    runStatus,
  };
}

function handleClaimedNodeFailure(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  params: ClaimedNodeFailureParams,
): ClaimedNodeFailure {
  const { currentAttempt, contextManifest, failureEvents, failureTokensUsed, error } = params;
  const errorMessage = toErrorMessage(error);
  const persistedNodeStatus = loadRunNodeExecutionRowById(db, run.id, node.runNodeId).status;
  const latestRunStatus = loadWorkflowRunRow(db, run.id).status;
  const retryEligible = persistedNodeStatus === 'running' && shouldRetryNodeAttempt(currentAttempt, node.maxRetries);
  const canRetryImmediately = retryEligible && latestRunStatus === 'running';
  const shouldDeferRetry = retryEligible && latestRunStatus === 'paused';
  const canRetry = canRetryImmediately || shouldDeferRetry;
  const retriesRemaining = Math.max(node.maxRetries - currentAttempt, 0);
  const failureReason = resolveFailureReason(persistedNodeStatus, canRetry);

  const artifactId = persistFailureArtifact(db, {
    workflowRunId: run.id,
    runNodeId: node.runNodeId,
    content: errorMessage,
    metadata: {
      success: false,
      provider: node.provider,
      nodeKey: node.nodeKey,
      attempt: currentAttempt,
      maxRetries: node.maxRetries,
      retriesRemaining,
      errorName: error instanceof Error ? error.name : 'Error',
      failureReason,
      nodeStatusAtFailure: persistedNodeStatus,
      ...contextManifest,
    },
  });

  if (persistedNodeStatus === 'running') {
    transitionRunNodeStatus(db, {
      runNodeId: node.runNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });
  }

  const persistedNode = loadRunNodeExecutionRowById(db, run.id, node.runNodeId);
  const diagnosticStatus: 'completed' | 'failed' = persistedNode.status === 'completed' ? 'completed' : 'failed';
  persistRunNodeAttemptDiagnostics(db, {
    workflowRunId: run.id,
    node,
    attempt: currentAttempt,
    outcome: 'failed',
    status: diagnosticStatus,
    runNodeSnapshot: persistedNode,
    contextManifest,
    tokensUsed: failureTokensUsed,
    events: failureEvents,
    routingDecision: null,
    error,
  });

  if (canRetry) {
    const nextAttempt = currentAttempt + 1;
    if (canRetryImmediately) {
      transitionFailedRunNodeToRetryAttempt(db, {
        runNodeId: node.runNodeId,
        currentAttempt,
        nextAttempt,
      });
      return {
        artifactId,
        runStatus: latestRunStatus,
        runNodeStatus: 'failed',
        nextAttempt,
        nextStepOutcome: null,
      };
    }

    transitionFailedRunNodeToPendingAttempt(db, {
      runNodeId: node.runNodeId,
      currentAttempt,
      nextAttempt,
    });
    return {
      artifactId,
      runStatus: latestRunStatus,
      runNodeStatus: 'failed',
      nextAttempt: null,
      nextStepOutcome: 'blocked',
    };
  }

  if (retryEligible && isTerminalWorkflowRunStatus(latestRunStatus)) {
    return {
      artifactId,
      runStatus: latestRunStatus,
      runNodeStatus: 'failed',
      nextAttempt: null,
      nextStepOutcome: 'run_terminal',
    };
  }

  const runStatus = transitionRunToCurrentForExecutor(db, run.id, 'failed');
  let runNodeStatus: 'completed' | 'failed' = 'failed';
  if (persistedNode.status === 'completed') {
    runNodeStatus = 'completed';
  }

  return {
    artifactId,
    runStatus,
    runNodeStatus,
    nextAttempt: null,
    nextStepOutcome: null,
  };
}

async function executeClaimedRunnableNode(
  db: AlphredDatabase,
  dependencies: SqlWorkflowExecutorDependencies,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  edgeRows: EdgeRow[],
  options: ProviderRunOptions,
  runStatus: WorkflowRunStatus,
): Promise<ExecuteNextRunnableNodeResult> {
  let currentRunStatus = runStatus;
  let currentAttempt = node.attempt;

  while (true) {
    const latestNodeAttemptsForContext = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
    const latestRoutingDecisionsForContext = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
    const latestArtifactsForContext = loadLatestArtifactsByRunNodeId(db, run.id);
    const contextAssembly = assembleUpstreamArtifactContext(db, {
      workflowRunId: run.id,
      targetNode: node,
      latestNodeAttempts: latestNodeAttemptsForContext,
      edgeRows,
      latestRoutingDecisionsByRunNodeId: latestRoutingDecisionsForContext.latestByRunNodeId,
      latestArtifactsByRunNodeId: latestArtifactsForContext,
    });
    let nextEventSequence = resolveNextRunNodeStreamSequence(db, {
      workflowRunId: run.id,
      runNodeId: node.runNodeId,
      attempt: currentAttempt,
    });
    const streamUsageState: StreamUsageState = {
      cumulativeTokens: null,
    };

    try {
      const phaseResult = await executeNodePhase(
        node,
        options,
        contextAssembly.contextEntries,
        dependencies,
        async (event) => {
          const sequence = nextEventSequence;
          nextEventSequence += 1;
          persistRunNodeStreamEvent(db, {
            workflowRunId: run.id,
            runNodeId: node.runNodeId,
            attempt: currentAttempt,
            sequence,
            event,
            usageState: streamUsageState,
          });
        },
      );
      const success = handleClaimedNodeSuccess(
        db,
        run,
        node,
        edgeRows,
        {
          currentAttempt,
          currentRunStatus,
          contextManifest: contextAssembly.manifest,
          phaseResult,
        },
      );
      currentRunStatus = success.runStatus;
      return buildExecutedNodeResult(run, node, 'completed', currentRunStatus, success.artifactId);
    } catch (error) {
      const failureEvents = error instanceof PhaseRunError ? error.events : [];
      const failureTokensUsed = error instanceof PhaseRunError ? error.tokensUsed : 0;
      const failure = handleClaimedNodeFailure(
        db,
        run,
        node,
        {
          currentAttempt,
          contextManifest: contextAssembly.manifest,
          failureEvents,
          failureTokensUsed,
          error,
        },
      );
      if (failure.nextAttempt !== null) {
        currentAttempt = failure.nextAttempt;
        continue;
      }

      if (failure.nextStepOutcome !== null) {
        return {
          outcome: failure.nextStepOutcome,
          workflowRunId: run.id,
          runStatus: failure.runStatus,
        };
      }

      currentRunStatus = failure.runStatus;
      return buildExecutedNodeResult(run, node, failure.runNodeStatus, currentRunStatus, failure.artifactId);
    }
  }
}

function applyWorkflowRunStatusControl(
  db: AlphredDatabase,
  params: {
    action: Extract<WorkflowRunControlAction, 'cancel' | 'pause' | 'resume'>;
    workflowRunId: number;
    targetStatus: WorkflowRunStatus;
    allowedFrom: ReadonlySet<WorkflowRunStatus>;
    noopStatuses: ReadonlySet<WorkflowRunStatus>;
    invalidTransitionMessage: (status: WorkflowRunStatus) => string;
  },
): WorkflowRunControlResult {
  let lastObservedStatus: WorkflowRunStatus | null = null;

  for (let attempt = 0; attempt < MAX_CONTROL_PRECONDITION_RETRIES; attempt += 1) {
    const run = loadWorkflowRunRow(db, params.workflowRunId);
    lastObservedStatus = run.status;

    if (params.noopStatuses.has(run.status)) {
      return createWorkflowRunControlResult({
        action: params.action,
        outcome: 'noop',
        workflowRunId: run.id,
        previousRunStatus: run.status,
        runStatus: run.status,
      });
    }

    if (!params.allowedFrom.has(run.status)) {
      throw createInvalidControlTransitionError({
        action: params.action,
        workflowRunId: run.id,
        runStatus: run.status,
        message: params.invalidTransitionMessage(run.status),
      });
    }

    try {
      let nextStatus: WorkflowRunStatus;
      if (params.action === 'cancel' && (run.status === 'pending' || run.status === 'paused')) {
        transitionWorkflowRunStatus(db, {
          workflowRunId: run.id,
          expectedFrom: run.status,
          to: 'cancelled',
        });
        nextStatus = 'cancelled';
      } else {
        nextStatus = transitionRunTo(db, run.id, run.status, params.targetStatus);
      }
      return createWorkflowRunControlResult({
        action: params.action,
        outcome: 'applied',
        workflowRunId: run.id,
        previousRunStatus: run.status,
        runStatus: nextStatus,
      });
    } catch (error) {
      if (isWorkflowRunTransitionPreconditionFailure(error)) {
        continue;
      }
      throw error;
    }
  }

  const fallbackStatus = lastObservedStatus ?? loadWorkflowRunRow(db, params.workflowRunId).status;
  throw createConcurrentControlConflictError({
    action: params.action,
    workflowRunId: params.workflowRunId,
    runStatus: fallbackStatus,
    message: `Failed to apply ${params.action} control for workflow run id=${params.workflowRunId} after retrying precondition conflicts.`,
  });
}

function applyWorkflowRunRetryControl(
  db: AlphredDatabase,
  params: WorkflowRunControlParams,
): WorkflowRunControlResult {
  let lastObservedStatus: WorkflowRunStatus | null = null;

  for (let attempt = 0; attempt < MAX_CONTROL_PRECONDITION_RETRIES; attempt += 1) {
    const run = loadWorkflowRunRow(db, params.workflowRunId);
    lastObservedStatus = run.status;

    if (run.status === 'running') {
      return createWorkflowRunControlResult({
        action: 'retry',
        outcome: 'noop',
        workflowRunId: run.id,
        previousRunStatus: run.status,
        runStatus: run.status,
      });
    }

    if (run.status !== 'failed') {
      throw createInvalidControlTransitionError({
        action: 'retry',
        workflowRunId: run.id,
        runStatus: run.status,
        message: `Cannot retry workflow run id=${run.id} from status "${run.status}". Expected status "failed".`,
      });
    }

    const retryTargets = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id))
      .filter(node => node.status === 'failed')
      .sort(compareNodeOrder);
    if (retryTargets.length === 0) {
      throw createRetryTargetsNotFoundError({
        action: 'retry',
        workflowRunId: run.id,
        runStatus: run.status,
        message: `Workflow run id=${run.id} is failed but has no failed run nodes to retry.`,
      });
    }

    try {
      const retriedRunNodeIds = db.transaction(tx => {
        const txRun = tx
          .select({
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, run.id))
          .get();
        if (!txRun || txRun.status !== 'failed') {
          throw new Error(
            `Workflow-run retry control precondition failed for id=${run.id}; expected status "failed".`,
          );
        }

        const occurredAt = new Date().toISOString();
        const retriedIds: number[] = [];
        for (const retryTarget of retryTargets) {
          transitionFailedRunNodeToPendingAttempt(tx, {
            runNodeId: retryTarget.runNodeId,
            currentAttempt: retryTarget.attempt,
            nextAttempt: retryTarget.attempt + 1,
          });
          retriedIds.push(retryTarget.runNodeId);
        }

        const updatedRun = tx
          .update(workflowRuns)
          .set({
            status: 'running',
            updatedAt: occurredAt,
            completedAt: null,
          })
          .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, 'failed')))
          .run();
        if (updatedRun.changes !== 1) {
          throw new Error(`Workflow-run transition precondition failed for id=${run.id}; expected status "failed".`);
        }

        return retriedIds;
      });

      return createWorkflowRunControlResult({
        action: 'retry',
        outcome: 'applied',
        workflowRunId: run.id,
        previousRunStatus: 'failed',
        runStatus: 'running',
        retriedRunNodeIds,
      });
    } catch (error) {
      if (
        isWorkflowRunTransitionPreconditionFailure(error)
        || isRunNodeRetryQueuePreconditionFailure(error)
        || isRetryControlPreconditionFailure(error)
      ) {
        continue;
      }
      throw error;
    }
  }

  const fallbackStatus = lastObservedStatus ?? loadWorkflowRunRow(db, params.workflowRunId).status;
  throw createConcurrentControlConflictError({
    action: 'retry',
    workflowRunId: params.workflowRunId,
    runStatus: fallbackStatus,
    message: `Failed to apply retry control for workflow run id=${params.workflowRunId} after retrying precondition conflicts.`,
  });
}

export function createSqlWorkflowExecutor(
  db: AlphredDatabase,
  dependencies: SqlWorkflowExecutorDependencies,
): SqlWorkflowExecutor {
  return {
    async executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult> {
      const initialRun = loadWorkflowRunRow(db, params.workflowRunId);
      if (runTerminalStatuses.has(initialRun.status)) {
        return {
          outcome: 'run_terminal',
          workflowRunId: initialRun.id,
          runStatus: initialRun.status,
        };
      }

      const runNodeRows = loadRunNodeExecutionRows(db, initialRun.id);
      const edgeRows = loadEdgeRows(db, initialRun.workflowTreeId);
      const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, initialRun.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, initialRun.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        routingDecisionSelection.latestByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      const currentRun = loadWorkflowRunRow(db, initialRun.id);
      if (runTerminalStatuses.has(currentRun.status)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus: currentRun.status,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: initialRun.status,
          nextRunStatus: runTerminalResult.runStatus,
        });
        return runTerminalResult;
      }

      if (nextRunnableNode && currentRun.status === 'paused') {
        return {
          outcome: 'blocked',
          workflowRunId: currentRun.id,
          runStatus: currentRun.status,
        };
      }

      if (!nextRunnableNode) {
        const result = resolveNoRunnableOutcome(
          db,
          currentRun,
          latestNodeAttempts,
          hasNoRouteDecision,
          hasUnresolvedDecision,
        );
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: currentRun.status,
          nextRunStatus: result.runStatus,
        });
        return result;
      }

      const runStatus = ensureRunIsRunning(db, currentRun);
      if (runStatus === 'paused') {
        return {
          outcome: 'blocked',
          workflowRunId: currentRun.id,
          runStatus,
        };
      }

      if (runTerminalStatuses.has(runStatus)) {
        const runTerminalResult: ExecuteNextRunnableNodeResult = {
          outcome: 'run_terminal',
          workflowRunId: currentRun.id,
          runStatus,
        };
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: currentRun.status,
          nextRunStatus: runTerminalResult.runStatus,
        });
        return runTerminalResult;
      }

      const claimResult = claimRunnableNode(db, currentRun, nextRunnableNode);
      if (claimResult) {
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: currentRun.id,
          previousRunStatus: currentRun.status,
          nextRunStatus: claimResult.runStatus,
        });
        return claimResult;
      }

      const claimedNode = loadRunNodeExecutionRowById(db, currentRun.id, nextRunnableNode.runNodeId);
      const result = await executeClaimedRunnableNode(
        db,
        dependencies,
        currentRun,
        claimedNode,
        edgeRows,
        params.options,
        runStatus,
      );
      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: currentRun.id,
        previousRunStatus: currentRun.status,
        nextRunStatus: result.runStatus,
      });
      return result;
    },

    async executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult> {
      const maxSteps = params.maxSteps ?? 1000;
      if (maxSteps <= 0) {
        throw new Error('maxSteps must be greater than zero.');
      }

      let executedNodes = 0;
      while (executedNodes < maxSteps) {
        const stepResult = await this.executeNextRunnableNode({
          workflowRunId: params.workflowRunId,
          options: params.options,
        });

        if (stepResult.outcome !== 'executed') {
          return {
            workflowRunId: params.workflowRunId,
            executedNodes,
            finalStep: stepResult,
          };
        }

        executedNodes += 1;
        if (runTerminalStatuses.has(stepResult.runStatus) || stepResult.runNodeStatus !== 'completed') {
          const finalOutcome: ExecuteWorkflowRunResult['finalStep'] = {
            outcome: 'run_terminal',
            workflowRunId: params.workflowRunId,
            runStatus: stepResult.runStatus,
          };
          return {
            workflowRunId: params.workflowRunId,
            executedNodes,
            finalStep: finalOutcome,
          };
        }
      }

      const run = loadWorkflowRunRow(db, params.workflowRunId);
      const runStatus = failRunOnIterationLimit(db, run, {
        maxSteps,
        executedNodes,
      });
      return {
        workflowRunId: params.workflowRunId,
        executedNodes,
        finalStep: {
          outcome: 'run_terminal',
          workflowRunId: params.workflowRunId,
          runStatus,
        },
      };
    },

    async cancelRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      const result = applyWorkflowRunStatusControl(db, {
        action: 'cancel',
        workflowRunId: params.workflowRunId,
        targetStatus: 'cancelled',
        allowedFrom: new Set(['pending', 'running', 'paused']),
        noopStatuses: new Set(['cancelled']),
        invalidTransitionMessage: status =>
          `Cannot cancel workflow run id=${params.workflowRunId} from status "${status}". Expected pending, running, or paused.`,
      });
      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: result.workflowRunId,
        previousRunStatus: result.previousRunStatus,
        nextRunStatus: result.runStatus,
      });
      return result;
    },

    async pauseRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunStatusControl(db, {
        action: 'pause',
        workflowRunId: params.workflowRunId,
        targetStatus: 'paused',
        allowedFrom: new Set(['running']),
        noopStatuses: new Set(['paused']),
        invalidTransitionMessage: status =>
          `Cannot pause workflow run id=${params.workflowRunId} from status "${status}". Expected status "running".`,
      });
    },

    async resumeRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunStatusControl(db, {
        action: 'resume',
        workflowRunId: params.workflowRunId,
        targetStatus: 'running',
        allowedFrom: new Set(['paused']),
        noopStatuses: new Set(['running']),
        invalidTransitionMessage: status =>
          `Cannot resume workflow run id=${params.workflowRunId} from status "${status}". Expected status "paused".`,
      });
    },

    async retryRun(params: WorkflowRunControlParams): Promise<WorkflowRunControlResult> {
      return applyWorkflowRunRetryControl(db, params);
    },
  };
}
