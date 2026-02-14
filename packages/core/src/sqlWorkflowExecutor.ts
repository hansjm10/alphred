import { asc, eq } from 'drizzle-orm';
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
const routingDecisionPattern = /^\s*decision\s*:\s*([a-z_]+)\s*$/im;

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

function parseRouteDecisionSignal(report: string): RouteDecisionSignal | null {
  const match = routingDecisionPattern.exec(report);
  if (!match) {
    return null;
  }

  const candidate = match[1].toLowerCase();
  if (!routeDecisionSignals.has(candidate as RouteDecisionSignal)) {
    return null;
  }

  return candidate as RouteDecisionSignal;
}

function doesEdgeMatchDecision(edge: EdgeRow, decisionType: RoutingDecisionType | null): boolean {
  if (edge.auto === 1) {
    return true;
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

function selectNextRunnableNode(
  rows: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
): NextRunnableSelection {
  const latestNodeAttempts = getLatestRunNodeAttempts(rows);
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>(latestNodeAttempts.map(row => [row.treeNodeId, row]));
  const incomingEdgesByTargetNodeId = new Map<number, EdgeRow[]>();
  const outgoingEdgesBySourceNodeId = new Map<number, EdgeRow[]>();
  for (const edge of edges) {
    const incomingEdges = incomingEdgesByTargetNodeId.get(edge.targetNodeId);
    if (incomingEdges) {
      incomingEdges.push(edge);
    } else {
      incomingEdgesByTargetNodeId.set(edge.targetNodeId, [edge]);
    }

    const outgoingEdges = outgoingEdgesBySourceNodeId.get(edge.sourceNodeId);
    if (outgoingEdges) {
      outgoingEdges.push(edge);
    } else {
      outgoingEdgesBySourceNodeId.set(edge.sourceNodeId, [edge]);
    }
  }

  const selectedEdgeIdBySourceNodeId = new Map<number, number>();
  let hasNoRouteDecision = false;
  for (const sourceNode of latestNodeAttempts) {
    if (sourceNode.status !== 'completed') {
      continue;
    }

    const outgoingEdges = outgoingEdgesBySourceNodeId.get(sourceNode.treeNodeId) ?? [];
    if (outgoingEdges.length === 0) {
      continue;
    }

    const decisionType = latestRoutingDecisionsByRunNodeId.get(sourceNode.runNodeId)?.decisionType ?? null;
    const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decisionType);
    if (matchingEdge) {
      selectedEdgeIdBySourceNodeId.set(sourceNode.treeNodeId, matchingEdge.edgeId);
      continue;
    }

    hasNoRouteDecision = true;
  }

  const nextRunnableNode =
    latestNodeAttempts.find((row) => {
      if (row.status !== 'pending') {
        return false;
      }

      const incomingEdges = incomingEdgesByTargetNodeId.get(row.treeNodeId) ?? [];
      if (incomingEdges.length === 0) {
        return true;
      }

      return incomingEdges.some((edge) => {
        const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
        if (sourceNode?.status !== 'completed') {
          return false;
        }

        return selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) === edge.edgeId;
      });
    }) ?? null;

  return {
    nextRunnableNode,
    latestNodeAttempts,
    hasNoRouteDecision,
  };
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
    nodeType: row.nodeType,
    provider: row.provider,
    prompt: row.prompt,
    promptContentType: row.promptContentType,
  }));
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
): RoutingDecisionType | null {
  const decisionSignal = parseRouteDecisionSignal(params.report);
  const outgoingEdges = params.edgeRows.filter(edge => edge.sourceNodeId === params.treeNodeId);

  if (outgoingEdges.length === 0) {
    if (!decisionSignal) {
      return null;
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
    return decisionSignal;
  }

  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decisionSignal);
  if (matchingEdge) {
    if (!decisionSignal) {
      return null;
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
    return decisionSignal;
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

  return 'no_route';
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

function resolveNoRunnableOutcome(
  db: AlphredDatabase,
  run: WorkflowRunRow,
  latestNodeAttempts: RunNodeExecutionRow[],
  hasNoRouteDecision: boolean,
): ExecuteNextRunnableNodeResult {
  const hasPending = latestNodeAttempts.some(node => node.status === 'pending');
  const hasRunning = latestNodeAttempts.some(node => node.status === 'running');
  const hasTerminalFailure = latestNodeAttempts.some(node => node.status === 'failed');

  if (hasNoRouteDecision) {
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
  runNodeId: number,
): ExecuteNextRunnableNodeResult | null {
  try {
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
    });
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
        tokensUsed: phaseResult.tokensUsed,
        eventCount: phaseResult.events.length,
      },
    });

    const routingDecision = persistCompletedNodeRoutingDecision(db, {
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

    if (routingDecision === 'no_route') {
      currentRunStatus = transitionRunTo(db, run.id, currentRunStatus, 'failed');
    } else {
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
    const artifactId = persistFailureArtifact(db, {
      workflowRunId: run.id,
      runNodeId: node.runNodeId,
      content: errorMessage,
      metadata: {
        success: false,
        provider: node.provider,
        nodeKey: node.nodeKey,
        errorName: error instanceof Error ? error.name : 'Error',
      },
    });

    transitionRunNodeStatus(db, {
      runNodeId: node.runNodeId,
      expectedFrom: 'running',
      to: 'failed',
    });

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
      const { nextRunnableNode, latestNodeAttempts, hasNoRouteDecision } = selectNextRunnableNode(
        runNodeRows,
        edgeRows,
        latestRoutingDecisionsByRunNodeId,
      );

      if (!nextRunnableNode) {
        return resolveNoRunnableOutcome(db, run, latestNodeAttempts, hasNoRouteDecision);
      }

      const runStatus = ensureRunIsRunning(db, run);
      const claimResult = claimRunnableNode(db, run, nextRunnableNode.runNodeId);
      if (claimResult) {
        return claimResult;
      }

      return executeClaimedRunnableNode(db, dependencies, run, nextRunnableNode, edgeRows, params.options, runStatus);
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
      throw new Error(
        `Execution loop exceeded maxSteps=${maxSteps} for workflow run id=${params.workflowRunId} (status=${run.status}).`,
      );
    },
  };
}
