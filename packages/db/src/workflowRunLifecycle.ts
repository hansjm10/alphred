import { and, eq } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import { workflowRuns } from './schema.js';

export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

const terminalStatuses: ReadonlySet<WorkflowRunStatus> = new Set(['completed', 'failed', 'cancelled']);

const allowedTransitions: Readonly<Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'paused'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: ['running'],
  cancelled: [],
};

export function assertValidWorkflowRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  const allowedTargets = allowedTransitions[from];
  if (!allowedTargets.includes(to)) {
    throw new Error(`Invalid workflow-run status transition: ${from} -> ${to}`);
  }
}

export function transitionWorkflowRunStatus(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    expectedFrom: WorkflowRunStatus;
    to: WorkflowRunStatus;
    occurredAt?: string;
  },
): void {
  assertValidWorkflowRunTransition(params.expectedFrom, params.to);

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const completedAt = terminalStatuses.has(params.to) ? occurredAt : null;
  const startedAt = params.expectedFrom === 'pending' && params.to === 'running' ? occurredAt : undefined;

  const updated = db
    .update(workflowRuns)
    .set({
      status: params.to,
      updatedAt: occurredAt,
      startedAt,
      completedAt,
    })
    .where(and(eq(workflowRuns.id, params.workflowRunId), eq(workflowRuns.status, params.expectedFrom)))
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Workflow-run transition precondition failed for id=${params.workflowRunId}; expected status "${params.expectedFrom}".`,
    );
  }
}
