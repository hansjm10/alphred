import { and, eq } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import { runNodes } from './schema.js';

export type RunNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

const terminalStatuses: ReadonlySet<RunNodeStatus> = new Set(['completed', 'failed', 'skipped', 'cancelled']);

const allowedTransitions: Readonly<Record<RunNodeStatus, readonly RunNodeStatus[]>> = {
  pending: ['running', 'skipped', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  // Attempt increment semantics for completed-node requeue are enforced by
  // executor-owned helpers, not this generic transition guard.
  completed: ['pending'],
  failed: ['running'],
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

  const updated = db
    .update(runNodes)
    .set({
      status: params.to,
      updatedAt: occurredAt,
      startedAt,
      completedAt,
    })
    .where(and(eq(runNodes.id, params.runNodeId), eq(runNodes.status, params.expectedFrom)))
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-node transition precondition failed for id=${params.runNodeId}; expected status "${params.expectedFrom}".`,
    );
  }
}
