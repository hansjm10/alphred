import { asc, eq } from 'drizzle-orm';
import {
  phaseArtifacts,
  promptTemplates,
  runNodes,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  treeEdges,
  treeNodes,
  workflowRuns,
  type AlphredDatabase,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import { compareStringsByCodeUnit, type AgentProviderName, type PhaseDefinition, type ProviderRunOptions } from '@alphred/shared';
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
  sourceNodeId: number;
  targetNodeId: number;
  auto: number;
};

type NextRunnableSelection = {
  nextRunnableNode: RunNodeExecutionRow | null;
  latestNodeAttempts: RunNodeExecutionRow[];
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

function selectNextRunnableNode(rows: RunNodeExecutionRow[], edges: EdgeRow[]): NextRunnableSelection {
  const latestNodeAttempts = getLatestRunNodeAttempts(rows);
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>(latestNodeAttempts.map(row => [row.treeNodeId, row]));

  const incomingEdgesByTargetNodeId = new Map<number, EdgeRow[]>();
  for (const edge of edges) {
    const incomingEdges = incomingEdgesByTargetNodeId.get(edge.targetNodeId);
    if (incomingEdges) {
      incomingEdges.push(edge);
      continue;
    }

    incomingEdgesByTargetNodeId.set(edge.targetNodeId, [edge]);
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
        if (edge.auto !== 1) {
          return false;
        }

        const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
        return sourceNode?.status === 'completed';
      });
    }) ?? null;

  return {
    nextRunnableNode,
    latestNodeAttempts,
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
      sourceNodeId: treeEdges.sourceNodeId,
      targetNodeId: treeEdges.targetNodeId,
      auto: treeEdges.auto,
    })
    .from(treeEdges)
    .where(eq(treeEdges.workflowTreeId, workflowTreeId))
    .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
    .all();
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
      const { nextRunnableNode, latestNodeAttempts } = selectNextRunnableNode(runNodeRows, edgeRows);

      if (!nextRunnableNode) {
        const hasPending = latestNodeAttempts.some(node => node.status === 'pending');
        const hasRunning = latestNodeAttempts.some(node => node.status === 'running');
        const hasTerminalFailure = latestNodeAttempts.some(node => node.status === 'failed');

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

      let runStatus = run.status === 'pending' ? transitionRunTo(db, run.id, run.status, 'running') : run.status;

      try {
        transitionRunNodeStatus(db, {
          runNodeId: nextRunnableNode.runNodeId,
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

      try {
        const phase = createExecutionPhase(nextRunnableNode);
        const phaseResult = await runPhase(phase, params.options, {
          resolveProvider: dependencies.resolveProvider,
        });

        const artifactId = persistSuccessArtifact(db, {
          workflowRunId: run.id,
          runNodeId: nextRunnableNode.runNodeId,
          content: phaseResult.report,
          contentType: nextRunnableNode.promptContentType,
          metadata: {
            success: true,
            provider: nextRunnableNode.provider,
            nodeKey: nextRunnableNode.nodeKey,
            tokensUsed: phaseResult.tokensUsed,
            eventCount: phaseResult.events.length,
          },
        });

        transitionRunNodeStatus(db, {
          runNodeId: nextRunnableNode.runNodeId,
          expectedFrom: 'running',
          to: 'completed',
        });

        const latestAfterSuccess = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, run.id));
        const targetRunStatus = resolveRunStatusFromNodes(latestAfterSuccess);
        runStatus = transitionRunTo(db, run.id, runStatus, targetRunStatus);

        return {
          outcome: 'executed',
          workflowRunId: run.id,
          runNodeId: nextRunnableNode.runNodeId,
          nodeKey: nextRunnableNode.nodeKey,
          runNodeStatus: 'completed',
          runStatus,
          artifactId,
        };
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        const artifactId = persistFailureArtifact(db, {
          workflowRunId: run.id,
          runNodeId: nextRunnableNode.runNodeId,
          content: errorMessage,
          metadata: {
            success: false,
            provider: nextRunnableNode.provider,
            nodeKey: nextRunnableNode.nodeKey,
            errorName: error instanceof Error ? error.name : 'Error',
          },
        });

        transitionRunNodeStatus(db, {
          runNodeId: nextRunnableNode.runNodeId,
          expectedFrom: 'running',
          to: 'failed',
        });

        runStatus = transitionRunTo(db, run.id, runStatus, 'failed');

        return {
          outcome: 'executed',
          workflowRunId: run.id,
          runNodeId: nextRunnableNode.runNodeId,
          nodeKey: nextRunnableNode.nodeKey,
          runNodeStatus: 'failed',
          runStatus,
          artifactId,
        };
      }
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
