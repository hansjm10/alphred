import { and, eq, inArray } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import { runNodes, workflowRuns } from './schema.js';
import type { WorkflowRunStatus } from './workflowRunLifecycle.js';

export type RunNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

const terminalStatuses: ReadonlySet<RunNodeStatus> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

const allowedTransitions: Readonly<Record<RunNodeStatus, readonly RunNodeStatus[]>> = {
  pending: ['running', 'skipped', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  // Attempt increment semantics for completed-node requeue are enforced by
  // executor-owned helpers, not this generic transition guard.
  completed: ['pending'],
  failed: ['running', 'pending'],
  skipped: ['pending'],
  cancelled: [],
};

export function assertValidRunNodeTransition(from: RunNodeStatus, to: RunNodeStatus): void {
  const allowedTargets = allowedTransitions[from];
  if (!allowedTargets.includes(to)) {
    throw new Error(`Invalid run-node status transition: ${from} -> ${to}`);
  }
}

export function transitionRunNodeStatus(
  db: AlphredDatabase,
  params: {
    runNodeId: number;
    expectedFrom: RunNodeStatus;
    to: RunNodeStatus;
    occurredAt?: string;
    workflowRunId?: number;
    requiredRunStatuses?: readonly WorkflowRunStatus[];
  },
): void {
  assertValidRunNodeTransition(params.expectedFrom, params.to);

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const completedAt = terminalStatuses.has(params.to) ? occurredAt : null;
  let startedAt: string | null | undefined;
  if (params.to === 'running') {
    startedAt = occurredAt;
  } else if (params.to === 'pending') {
    startedAt = null;
  }

  const whereClauses = [eq(runNodes.id, params.runNodeId), eq(runNodes.status, params.expectedFrom)];
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
      status: params.to,
      updatedAt: occurredAt,
      startedAt,
      completedAt,
    })
    .where(and(...whereClauses))
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node transition precondition failed for id=${params.runNodeId}; expected status "${params.expectedFrom}".`,
    );
  }
}
