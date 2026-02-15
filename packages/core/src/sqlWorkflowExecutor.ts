import { and, asc, eq } from 'drizzle-orm';
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

type RoutingDecisionType = 'approved' | 'changes_requested' | 'blocked' | 'retry' | 'no_route';
type RouteDecisionSignal = Exclude<RoutingDecisionType, 'no_route'>;

type RoutingDecisionRow = {
  id: number;
  runNodeId: number;
  decisionType: RoutingDecisionType;
  createdAt: string;
};

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
};

export type SqlWorkflowExecutor = {
  executeNextRunnableNode(params: ExecuteNextRunnableNodeParams): Promise<ExecuteNextRunnableNodeResult>;
  executeRun(params: ExecuteWorkflowRunParams): Promise<ExecuteWorkflowRunResult>;
};

const artifactContentTypes = new Set(['text', 'markdown', 'json', 'diff']);
const runTerminalStatuses = new Set<WorkflowRunStatus>(['completed', 'failed', 'cancelled']);
const routeDecisionSignals: ReadonlySet<RouteDecisionSignal> = new Set([
  'approved',
  'changes_requested',
  'blocked',
  'retry',
]);
const guardOperators: ReadonlySet<GuardCondition['operator']> = new Set(['==', '!=', '>', '<', '>=', '<=']);
const decisionKeyword = 'decision';

function toRunNodeStatus(value: string): RunNodeStatus {
  return value as RunNodeStatus;
}

function toWorkflowRunStatus(value: string): WorkflowRunStatus {
  return value as WorkflowRunStatus;
}

function normalizeArtifactContentType(value: string | null): 'text' | 'markdown' | 'json' | 'diff' {
  if (value && artifactContentTypes.has(value)) {
    return value as 'text' | 'markdown' | 'json' | 'diff';
  }

  return 'markdown';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function isAsciiWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0b || codeUnit === 0x0c || codeUnit === 0x0d;
}

function toLowerAscii(codeUnit: number): number {
  if (codeUnit >= 0x41 && codeUnit <= 0x5a) {
    return codeUnit + 0x20;
  }

  return codeUnit;
}

function isAsciiLetterOrUnderscore(codeUnit: number): boolean {
  return (
    codeUnit === 0x5f ||
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a)
  );
}

function codePointAtOrNegativeOne(value: string, index: number): number {
  return value.codePointAt(index) ?? -1;
}

function skipAsciiWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && isAsciiWhitespace(codePointAtOrNegativeOne(value, index))) {
    index += 1;
  }

  return index;
}

function consumeDecisionKeyword(line: string, start: number): number | null {
  for (let keywordIndex = 0; keywordIndex < decisionKeyword.length; keywordIndex += 1) {
    const lineIndex = start + keywordIndex;
    if (lineIndex >= line.length) {
      return null;
    }

    const actual = toLowerAscii(codePointAtOrNegativeOne(line, lineIndex));
    const expected = codePointAtOrNegativeOne(decisionKeyword, keywordIndex);
    if (actual !== expected) {
      return null;
    }
  }

  return start + decisionKeyword.length;
}

function readDecisionToken(
  line: string,
  start: number,
): {
  token: string;
  nextIndex: number;
} | null {
  let index = start;
  while (index < line.length && isAsciiLetterOrUnderscore(codePointAtOrNegativeOne(line, index))) {
    index += 1;
  }

  if (index === start) {
    return null;
  }

  return {
    token: line.slice(start, index),
    nextIndex: index,
  };
}

function parseRouteDecisionLine(line: string): RouteDecisionSignal | null {
  const keywordStart = skipAsciiWhitespace(line, 0);
  const afterKeyword = consumeDecisionKeyword(line, keywordStart);
  if (afterKeyword === null) {
    return null;
  }

  let index = skipAsciiWhitespace(line, afterKeyword);
  if (index >= line.length || codePointAtOrNegativeOne(line, index) !== 0x3a) {
    return null;
  }
  index = skipAsciiWhitespace(line, index + 1);

  const token = readDecisionToken(line, index);
  if (!token) {
    return null;
  }
  index = skipAsciiWhitespace(line, token.nextIndex);

  if (index !== line.length) {
    return null;
  }

  const candidate = token.token.toLowerCase();
  if (!routeDecisionSignals.has(candidate as RouteDecisionSignal)) {
    return null;
  }

  return candidate as RouteDecisionSignal;
}

function findLineBreakIndex(report: string, start: number): number {
  for (let index = start; index < report.length; index += 1) {
    const codePoint = codePointAtOrNegativeOne(report, index);
    if (codePoint === 0x0a || codePoint === 0x0d) {
      return index;
    }
  }

  return report.length;
}

function moveToNextLineStart(report: string, lineBreakIndex: number): number {
  const current = codePointAtOrNegativeOne(report, lineBreakIndex);
  if (current === 0x0d && codePointAtOrNegativeOne(report, lineBreakIndex + 1) === 0x0a) {
    return lineBreakIndex + 2;
  }

  return lineBreakIndex + 1;
}

function parseRouteDecisionSignal(report: string): RouteDecisionSignal | null {
  let lineStart = 0;

  while (lineStart <= report.length) {
    const lineEnd = findLineBreakIndex(report, lineStart);
    const parsed = parseRouteDecisionLine(report.slice(lineStart, lineEnd));
    if (parsed) {
      return parsed;
    }

    if (lineEnd >= report.length) {
      break;
    }

    lineStart = moveToNextLineStart(report, lineEnd);
  }

  return null;
}

function doesEdgeMatchDecision(edge: EdgeRow, decisionType: RoutingDecisionType | null): boolean {
  if (edge.auto === 1) {
    return true;
  }

  // Guarded routes require a concrete decision signal from the phase output.
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
): Map<number, RoutingDecisionRow> {
  const rows = db
    .select({
      id: routingDecisions.id,
      runNodeId: routingDecisions.runNodeId,
      decisionType: routingDecisions.decisionType,
      createdAt: routingDecisions.createdAt,
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
      decisionType: row.decisionType as RoutingDecisionType,
      createdAt: row.createdAt,
    });
  }

  return latestByRunNodeId;
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

function appendEdgeToNodeMap(edgesByNodeId: Map<number, EdgeRow[]>, nodeId: number, edge: EdgeRow): void {
  const edges = edgesByNodeId.get(nodeId);
  if (edges) {
    edges.push(edge);
    return;
  }
  edgesByNodeId.set(nodeId, [edge]);
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
    if (outgoingEdges.length === 0) {
      continue;
    }

    const persistedDecision = latestRoutingDecisionsByRunNodeId.get(sourceNode.runNodeId) ?? null;
    const latestArtifact = latestArtifactsByRunNodeId.get(sourceNode.runNodeId) ?? null;
    const decision =
      persistedDecision && latestArtifact && persistedDecision.createdAt < latestArtifact.createdAt
        ? null
        : persistedDecision;
    const decisionType = decision?.decisionType ?? null;
    const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decisionType);
    if (matchingEdge) {
      selectedEdgeIdBySourceNodeId.set(sourceNode.treeNodeId, matchingEdge.edgeId);
      continue;
    }

    if (decision) {
      hasNoRouteDecision = true;
      continue;
    }

    unresolvedDecisionSourceNodeIds.add(sourceNode.treeNodeId);
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
    const latestRoutingDecisionsByRunNodeId = loadLatestRoutingDecisionsByRunNodeId(db, workflowRunId);
    const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, workflowRunId);
    const routingSelection = buildRoutingSelection(
      latestNodeAttempts,
      edgeRows,
      latestRoutingDecisionsByRunNodeId,
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

function isRunNodeTransitionPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Run-node transition precondition failed')
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
    report: string;
    edgeRows: EdgeRow[];
  },
): CompletedNodeRoutingOutcome {
  const decisionSignal = parseRouteDecisionSignal(params.report);
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
        source: 'phase_result',
        decision: decisionSignal,
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
        source: 'phase_result',
        decision: decisionSignal,
        selectedEdgeId: matchingEdge.edgeId,
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
      source: 'phase_result',
      parsedDecision: decisionSignal,
      outgoingEdgeIds: outgoingEdges.map(edge => edge.edgeId),
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
  transitionRunNodeStatus(db, {
    runNodeId: params.runNodeId,
    expectedFrom: 'completed',
    to: 'pending',
  });

  const occurredAt = new Date().toISOString();
  const updated = db
    .update(runNodes)
    .set({
      attempt: params.nextAttempt,
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(runNodes.id, params.runNodeId),
        eq(runNodes.status, 'pending'),
        eq(runNodes.attempt, params.currentAttempt),
      ),
    )
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node revisit attempt update precondition failed for id=${params.runNodeId}; expected attempt=${params.currentAttempt}.`,
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
    return;
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
  const latestRoutingDecisionsByRunNodeId = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
  const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, run.id);
  const { nextRunnableNode, latestNodeAttempts } = selectNextRunnableNode(
    runNodeRows,
    edgeRows,
    latestRoutingDecisionsByRunNodeId,
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
    if (isRunNodeTransitionPreconditionFailure(error)) {
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
    try {
      const phase = createExecutionPhase(node);
      const phaseResult = await runPhase(phase, options, {
        resolveProvider: dependencies.resolveProvider,
      });

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
        },
      });

      const routingOutcome = persistCompletedNodeRoutingDecision(db, {
        workflowRunId: run.id,
        runNodeId: node.runNodeId,
        treeNodeId: node.treeNodeId,
        report: phaseResult.report,
        edgeRows,
      });

      transitionRunNodeStatus(db, {
        runNodeId: node.runNodeId,
        expectedFrom: 'running',
        to: 'completed',
      });

      if (routingOutcome.decisionType === 'no_route') {
        currentRunStatus = transitionRunTo(db, run.id, currentRunStatus, 'failed');
      } else {
        reactivateSelectedTargetNode(db, {
          workflowRunId: run.id,
          selectedEdgeId: routingOutcome.selectedEdgeId,
          edgeRows,
        });
        markUnreachablePendingNodesAsSkipped(db, run.id, edgeRows);
        const latestAfterSuccess = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
        const targetRunStatus = resolveRunStatusFromNodes(latestAfterSuccess);
        currentRunStatus = transitionRunTo(db, run.id, currentRunStatus, targetRunStatus);
      }

      return {
        outcome: 'executed',
        workflowRunId: run.id,
        runNodeId: node.runNodeId,
        nodeKey: node.nodeKey,
        runNodeStatus: 'completed',
        runStatus: currentRunStatus,
        artifactId,
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const canRetry = shouldRetryNodeAttempt(currentAttempt, node.maxRetries);
      const retriesRemaining = Math.max(node.maxRetries - currentAttempt, 0);

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
          failureReason: canRetry ? 'retry_scheduled' : 'retry_limit_exceeded',
        },
      });

      transitionRunNodeStatus(db, {
        runNodeId: node.runNodeId,
        expectedFrom: 'running',
        to: 'failed',
      });

      if (canRetry) {
        const nextAttempt = currentAttempt + 1;
        transitionFailedRunNodeToRetryAttempt(db, {
          runNodeId: node.runNodeId,
          currentAttempt,
          nextAttempt,
        });
        currentAttempt = nextAttempt;
        continue;
      }

      currentRunStatus = transitionRunTo(db, run.id, currentRunStatus, 'failed');

      return {
        outcome: 'executed',
        workflowRunId: run.id,
        runNodeId: node.runNodeId,
        nodeKey: node.nodeKey,
        runNodeStatus: 'failed',
        runStatus: currentRunStatus,
        artifactId,
      };
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
      const latestRoutingDecisionsByRunNodeId = loadLatestRoutingDecisionsByRunNodeId(db, run.id);
      const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, run.id);
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        latestRoutingDecisionsByRunNodeId,
        latestArtifactsByRunNodeId,
      );

      if (!nextRunnableNode) {
        return resolveNoRunnableOutcome(db, run, latestNodeAttempts, hasNoRouteDecision, hasUnresolvedDecision);
      }

      const runStatus = ensureRunIsRunning(db, run);
      const claimResult = claimRunnableNode(db, run, nextRunnableNode);
      if (claimResult) {
        return claimResult;
      }
      const claimedNode = loadRunNodeExecutionRowById(db, run.id, nextRunnableNode.runNodeId);
      return executeClaimedRunnableNode(db, dependencies, run, claimedNode, edgeRows, params.options, runStatus);
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
