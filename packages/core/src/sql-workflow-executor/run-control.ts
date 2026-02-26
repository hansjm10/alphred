import { and, eq } from 'drizzle-orm';
import { transitionWorkflowRunStatus, workflowRuns, type AlphredDatabase, type WorkflowRunStatus } from '@alphred/db';
import { MAX_CONTROL_PRECONDITION_RETRIES } from './constants.js';
import { loadRunNodeExecutionRows, loadWorkflowRunRow } from './persistence.js';
import {
  isWorkflowRunTransitionPreconditionFailure,
  transitionFailedRunNodeToPendingAttempt,
  transitionRunTo,
} from './transitions.js';
import { compareNodeOrder, getLatestRunNodeAttempts } from './type-conversions.js';
import type {
  WorkflowRunControlAction,
  WorkflowRunControlParams,
  WorkflowRunControlResult,
} from './types.js';
import { WorkflowRunControlError } from './types.js';

export function isRunNodeRetryQueuePreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Run-node retry requeue precondition failed');
}

export function isRetryControlPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Workflow-run retry control precondition failed');
}

export function createWorkflowRunControlResult(
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

export function createInvalidControlTransitionError(
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

export function createConcurrentControlConflictError(
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

export function createRetryTargetsNotFoundError(
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


export function applyWorkflowRunStatusControl(
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

export function applyWorkflowRunRetryControl(
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
        if (txRun?.status !== 'failed') {
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
