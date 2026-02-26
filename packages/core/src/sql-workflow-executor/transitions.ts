import { and, eq, inArray } from 'drizzle-orm';
import {
  runNodes,
  transitionRunNodeStatus,
  transitionWorkflowRunStatus,
  workflowRuns,
  type AlphredDatabase,
  type WorkflowRunStatus,
} from '@alphred/db';
import {
  MAX_CONTROL_PRECONDITION_RETRIES,
  runClaimableStatuses,
  runTerminalStatuses,
} from './constants.js';
import { createEmptyContextManifest } from './context-assembly.js';
import { persistRunNodeAttemptDiagnostics } from './diagnostics-persistence.js';
import { selectNextRunnableNode } from './node-selection.js';
import {
  loadEdgeRows,
  loadRunNodeExecutionRowById,
  loadRunNodeExecutionRows,
  loadWorkflowRunRow,
  persistFailureArtifact,
} from './persistence.js';
import { loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import { getLatestRunNodeAttempts } from './type-conversions.js';
import type {
  EdgeRow,
  ExecuteNextRunnableNodeResult,
  RunNodeExecutionRow,
  SqlWorkflowExecutorDependencies,
  TerminalWorkflowRunStatus,
  WorkflowRunRow,
} from './types.js';

export function isRunNodeClaimPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Run-node transition precondition failed') ||
      error.message.startsWith('Run-node revisit claim precondition failed'))
  );
}

export function isWorkflowRunTransitionPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Workflow-run transition precondition failed');
}


export function transitionRunTo(
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

export function transitionRunToCurrentForExecutor(
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

export function isTerminalWorkflowRunStatus(status: WorkflowRunStatus): status is TerminalWorkflowRunStatus {
  return runTerminalStatuses.has(status);
}

export async function notifyRunTerminalTransition(
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

export function resolveExecutionTerminalNotificationPreviousStatus(
  previousRunStatus: WorkflowRunStatus,
  nextRunStatus: WorkflowRunStatus,
): WorkflowRunStatus {
  if (nextRunStatus === 'cancelled') {
    return nextRunStatus;
  }

  return previousRunStatus;
}

export function resolveRunStatusFromNodes(latestNodeAttempts: RunNodeExecutionRow[]): WorkflowRunStatus {
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


export function shouldRetryNodeAttempt(attempt: number, maxRetries: number): boolean {
  return attempt <= maxRetries;
}

export function transitionFailedRunNodeToRetryAttempt(
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

export function transitionFailedRunNodeToPendingAttempt(
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

export function transitionCompletedRunNodeToPendingAttempt(
  db: AlphredDatabase,
  params: {
    runNodeId: number;
    currentAttempt: number;
    nextAttempt: number;
    workflowRunId?: number;
    requiredRunStatuses?: readonly WorkflowRunStatus[];
  },
): void {
  // Requeue completed nodes through this helper so status reset and attempt
  // increment remain coupled in one atomic update.
  const occurredAt = new Date().toISOString();
  const whereClauses = [
    eq(runNodes.id, params.runNodeId),
    eq(runNodes.status, 'completed'),
    eq(runNodes.attempt, params.currentAttempt),
  ];
  if (params.workflowRunId !== undefined) {
    whereClauses.push(eq(runNodes.workflowRunId, params.workflowRunId));
  }

  if (params.requiredRunStatuses !== undefined) {
    if (params.workflowRunId === undefined) {
      throw new Error('workflowRunId must be provided when requiredRunStatuses is set.');
    }

    whereClauses.push(
      inArray(
        runNodes.workflowRunId,
        db
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.id, params.workflowRunId),
              inArray(workflowRuns.status, [...params.requiredRunStatuses]),
            ),
          ),
      ),
    );
  }

  const updated = db
    .update(runNodes)
    .set({
      status: 'pending',
      attempt: params.nextAttempt,
      startedAt: null,
      completedAt: null,
      updatedAt: occurredAt,
    })
    .where(and(...whereClauses))
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node revisit claim precondition failed for id=${params.runNodeId}; expected status "completed" and attempt=${params.currentAttempt}.`,
    );
  }
}

export function reactivateSelectedTargetNode(
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

export function failRunOnIterationLimit(
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

export function resolveNoRunnableOutcome(
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

export function ensureRunIsRunning(db: AlphredDatabase, run: WorkflowRunRow): WorkflowRunStatus {
  return transitionRunToCurrentForExecutor(db, run.id, 'running');
}

export function claimRunnableNode(
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
        workflowRunId: run.id,
        requiredRunStatuses: runClaimableStatuses,
      });
    } else if (node.status === 'completed') {
      transitionCompletedRunNodeToPendingAttempt(db, {
        runNodeId: node.runNodeId,
        currentAttempt: node.attempt,
        nextAttempt: node.attempt + 1,
        workflowRunId: run.id,
        requiredRunStatuses: runClaimableStatuses,
      });
      transitionRunNodeStatus(db, {
        runNodeId: node.runNodeId,
        expectedFrom: 'pending',
        to: 'running',
        workflowRunId: run.id,
        requiredRunStatuses: runClaimableStatuses,
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
