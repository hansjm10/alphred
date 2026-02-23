import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  guardDefinitions,
  phaseArtifacts,
  promptTemplates,
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
  type AgentProviderName,
  type GuardCondition,
  type GuardExpression,
  type PhaseDefinition,
  type ProviderRunOptions,
  type RoutingDecisionSignal,
} from '@alphred/shared';
import { evaluateGuard } from './guards.js';
import { runPhase, type PhaseProviderResolver } from './phaseRunner.js';

type RunNodeExecutionRow = {
  runNodeId: number;
  treeNodeId: number;
  nodeKey: string;
  status: RunNodeStatus;
  sequenceIndex: number;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  maxRetries: number;
  nodeType: string;
  provider: string | null;
  model: string | null;
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

export type SqlWorkflowExecutorDependencies = {
  resolveProvider: PhaseProviderResolver;
  onRunTerminal?: (params: { workflowRunId: number; runStatus: TerminalWorkflowRunStatus }) => Promise<void> | void;
};

export type SqlWorkflowExecutor = {
  executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult>;
  executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult>;
};

const artifactContentTypes = new Set(['text', 'markdown', 'json', 'diff']);
const runTerminalStatuses = new Set<WorkflowRunStatus>(['completed', 'failed', 'cancelled']);
const guardOperators: ReadonlySet<GuardCondition['operator']> = new Set(['==', '!=', '>', '<', '>=', '<=']);
const CONTEXT_POLICY_VERSION = 1;
const MAX_UPSTREAM_ARTIFACTS = 4;
const MAX_CONTEXT_CHARS_TOTAL = 32_000;
const MAX_CHARS_PER_ARTIFACT = 12_000;
const MIN_REMAINING_CONTEXT_CHARS = 1_000;

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
    if (!sourceNode || sourceNode.status !== 'completed') {
      continue;
    }

    seenSourceNodeIds.add(edge.sourceNodeId);
    predecessors.push(sourceNode);
  }

  return predecessors.sort(compareUpstreamSourceOrder);
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

    if (remainingChars <= 0) {
      budgetOverflow = true;
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    let includedContent = truncateHeadTail(candidate.originalContent, MAX_CHARS_PER_ARTIFACT);
    if (includedContent.length > remainingChars) {
      budgetOverflow = true;
      if (remainingChars < MIN_REMAINING_CONTEXT_CHARS) {
        droppedArtifactIds.push(candidate.artifactId);
        continue;
      }
      includedContent = truncateHeadTail(candidate.originalContent, Math.min(MAX_CHARS_PER_ARTIFACT, remainingChars));
    }

    if (includedContent.length <= 0) {
      budgetOverflow = true;
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    const truncation = buildTruncationMetadata(candidate.originalContent.length, includedContent.length);
    includedEntries.push({
      ...candidate,
      includedContent,
      truncation,
    });
    remainingChars -= includedContent.length;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRunNodeClaimPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Run-node transition precondition failed') ||
      error.message.startsWith('Run-node revisit claim precondition failed'))
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
      startedAt: runNodes.startedAt,
      completedAt: runNodes.completedAt,
      maxRetries: treeNodes.maxRetries,
      nodeType: treeNodes.nodeType,
      provider: treeNodes.provider,
      model: treeNodes.model,
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
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    maxRetries: row.maxRetries,
    nodeType: row.nodeType,
    provider: row.provider,
    model: row.model,
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
  }

  return transitionRunTo(db, run.id, run.status, 'failed');
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
    const runStatus = transitionRunTo(db, run.id, run.status, 'failed');
    return {
      outcome: 'blocked',
      workflowRunId: run.id,
      runStatus,
    };
  }

  if (!hasPending && !hasRunning) {
    const resolvedRunStatus = hasTerminalFailure ? 'failed' : 'completed';
    const runStatus = transitionRunTo(db, run.id, run.status, resolvedRunStatus);
    return {
      outcome: 'no_runnable',
      workflowRunId: run.id,
      runStatus,
    };
  }

  if (hasTerminalFailure) {
    const runStatus = transitionRunTo(db, run.id, run.status, 'failed');
    return {
      outcome: 'blocked',
      workflowRunId: run.id,
      runStatus,
    };
  }

  const runStatus = run.status === 'pending' ? transitionRunTo(db, run.id, run.status, 'running') : run.status;
  return {
    outcome: 'blocked',
    workflowRunId: run.id,
    runStatus,
  };
}

function ensureRunIsRunning(db: AlphredDatabase, run: WorkflowRunRow): WorkflowRunStatus {
  if (run.status === 'pending') {
    return transitionRunTo(db, run.id, run.status, 'running');
  }

  return run.status;
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

type ClaimedNodeFailure = {
  artifactId: number;
  runStatus: WorkflowRunStatus;
  runNodeStatus: 'completed' | 'failed';
  nextAttempt: number | null;
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
): Promise<Awaited<ReturnType<typeof runPhase>>> {
  const phase = createExecutionPhase(node);
  const optionsWithContext =
    upstreamContextEntries.length === 0
      ? options
      : {
          ...options,
          context: [...(options.context ?? []), ...upstreamContextEntries],
        };
  const phaseOptions = phase.model ? { ...optionsWithContext, model: phase.model } : optionsWithContext;
  return runPhase(phase, phaseOptions, {
    resolveProvider: dependencies.resolveProvider,
  });
}

function handleClaimedNodeSuccess(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  node: RunNodeExecutionRow,
  edgeRows: EdgeRow[],
  currentAttempt: number,
  currentRunStatus: WorkflowRunStatus,
  contextManifest: ContextHandoffManifest,
  phaseResult: Awaited<ReturnType<typeof runPhase>>,
): ClaimedNodeSuccess {
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

  let runStatus = currentRunStatus;
  if (routingOutcome.decisionType === 'no_route') {
    runStatus = transitionRunTo(db, run.id, runStatus, 'failed');
  } else {
    reactivateSelectedTargetNode(db, {
      workflowRunId: run.id,
      selectedEdgeId: routingOutcome.selectedEdgeId,
      edgeRows,
    });
    markUnreachablePendingNodesAsSkipped(db, run.id, edgeRows);
    const latestAfterSuccess = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
    const targetRunStatus = resolveRunStatusFromNodes(latestAfterSuccess);
    runStatus = transitionRunTo(db, run.id, runStatus, targetRunStatus);
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
  currentAttempt: number,
  currentRunStatus: WorkflowRunStatus,
  contextManifest: ContextHandoffManifest,
  error: unknown,
): ClaimedNodeFailure {
  const errorMessage = toErrorMessage(error);
  const persistedNodeStatus = loadRunNodeExecutionRowById(db, run.id, node.runNodeId).status;
  const canRetry = persistedNodeStatus === 'running' && shouldRetryNodeAttempt(currentAttempt, node.maxRetries);
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

  if (canRetry) {
    const nextAttempt = currentAttempt + 1;
    transitionFailedRunNodeToRetryAttempt(db, {
      runNodeId: node.runNodeId,
      currentAttempt,
      nextAttempt,
    });
    return {
      artifactId,
      runStatus: currentRunStatus,
      runNodeStatus: 'failed',
      nextAttempt,
    };
  }

  const runStatus = transitionRunTo(db, run.id, currentRunStatus, 'failed');
  let runNodeStatus: 'completed' | 'failed' = 'failed';
  if (persistedNodeStatus === 'completed') {
    runNodeStatus = 'completed';
  }

  return {
    artifactId,
    runStatus,
    runNodeStatus,
    nextAttempt: null,
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

    try {
      const phaseResult = await executeNodePhase(node, options, contextAssembly.contextEntries, dependencies);
      const success = handleClaimedNodeSuccess(
        db,
        run,
        node,
        edgeRows,
        currentAttempt,
        currentRunStatus,
        contextAssembly.manifest,
        phaseResult,
      );
      currentRunStatus = success.runStatus;
      return buildExecutedNodeResult(run, node, 'completed', currentRunStatus, success.artifactId);
    } catch (error) {
      const failure = handleClaimedNodeFailure(
        db,
        run,
        node,
        currentAttempt,
        currentRunStatus,
        contextAssembly.manifest,
        error,
      );
      if (failure.nextAttempt !== null) {
        currentAttempt = failure.nextAttempt;
        continue;
      }

      currentRunStatus = failure.runStatus;
      return buildExecutedNodeResult(run, node, failure.runNodeStatus, currentRunStatus, failure.artifactId);
    }
  }
}

export function createSqlWorkflowExecutor(
  db: AlphredDatabase,
  dependencies: SqlWorkflowExecutorDependencies,
): SqlWorkflowExecutor {
  return {
    async executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult> {
      const run = loadWorkflowRunRow(db, params.workflowRunId);
      if (runTerminalStatuses.has(run.status)) {
        return {
          outcome: 'run_terminal',
          workflowRunId: run.id,
          runStatus: run.status,
        };
      }

      const runNodeRows = loadRunNodeExecutionRows(db, run.id);
      const edgeRows = loadEdgeRows(db, run.workflowTreeId);
      const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, run.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        routingDecisionSelection.latestByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      if (!nextRunnableNode) {
        const result = resolveNoRunnableOutcome(db, run, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision);
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: run.id,
          previousRunStatus: run.status,
          nextRunStatus: result.runStatus,
        });
        return result;
      }

      const runStatus = ensureRunIsRunning(db, run);
      const claimResult = claimRunnableNode(db, run, nextRunnableNode);
      if (claimResult) {
        await notifyRunTerminalTransition(dependencies, {
          workflowRunId: run.id,
          previousRunStatus: run.status,
          nextRunStatus: claimResult.runStatus,
        });
        return claimResult;
      }
      const claimedNode = loadRunNodeExecutionRowById(db, run.id, nextRunnableNode.runNodeId);
      const result = await executeClaimedRunnableNode(db, dependencies, run, claimedNode, edgeRows, params.options, runStatus);
      await notifyRunTerminalTransition(dependencies, {
        workflowRunId: run.id,
        previousRunStatus: run.status,
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
  };
}
