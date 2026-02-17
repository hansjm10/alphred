import { and, asc, eq } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import { runWorktrees } from './schema.js';

type RunWorktreeRow = typeof runWorktrees.$inferSelect;

export type RunWorktreeStatus = 'active' | 'removed';

export type RunWorktreeRecord = {
  id: number;
  workflowRunId: number;
  repositoryId: number;
  worktreePath: string;
  branch: string;
  commitHash: string | null;
  status: RunWorktreeStatus;
  createdAt: string;
  removedAt: string | null;
};

export type InsertRunWorktreeParams = {
  workflowRunId: number;
  repositoryId: number;
  worktreePath: string;
  branch: string;
  commitHash?: string | null;
  occurredAt?: string;
};

function assertKnownRunWorktreeStatus(status: string): asserts status is RunWorktreeStatus {
  if (status !== 'active' && status !== 'removed') {
    throw new Error(`Unknown run-worktree status: ${status}`);
  }
}

function toRunWorktreeRecord(row: RunWorktreeRow): RunWorktreeRecord {
  assertKnownRunWorktreeStatus(row.status);

  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    repositoryId: row.repositoryId,
    worktreePath: row.worktreePath,
    branch: row.branch,
    commitHash: row.commitHash,
    status: row.status,
    createdAt: row.createdAt,
    removedAt: row.removedAt,
  };
}

export function insertRunWorktree(db: AlphredDatabase, params: InsertRunWorktreeParams): RunWorktreeRecord {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const inserted = db
    .insert(runWorktrees)
    .values({
      workflowRunId: params.workflowRunId,
      repositoryId: params.repositoryId,
      worktreePath: params.worktreePath,
      branch: params.branch,
      commitHash: params.commitHash ?? null,
      status: 'active',
      createdAt: occurredAt,
      removedAt: null,
    })
    .run();

  const runWorktreeId = Number(inserted.lastInsertRowid);
  const created = getRunWorktreeById(db, runWorktreeId);
  if (!created) {
    throw new Error(`Run-worktree insert did not return a row for id=${runWorktreeId}.`);
  }

  return created;
}

export function getRunWorktreeById(db: AlphredDatabase, runWorktreeId: number): RunWorktreeRecord | null {
  const row = db
    .select()
    .from(runWorktrees)
    .where(eq(runWorktrees.id, runWorktreeId))
    .get();

  if (!row) {
    return null;
  }

  return toRunWorktreeRecord(row);
}

export function listRunWorktreesForRun(
  db: AlphredDatabase,
  workflowRunId: number,
  params: {
    status?: RunWorktreeStatus;
  } = {},
): RunWorktreeRecord[] {
  const where = params.status === undefined
    ? eq(runWorktrees.workflowRunId, workflowRunId)
    : and(eq(runWorktrees.workflowRunId, workflowRunId), eq(runWorktrees.status, params.status));

  const rows = db
    .select()
    .from(runWorktrees)
    .where(where)
    .orderBy(asc(runWorktrees.createdAt), asc(runWorktrees.id))
    .all();

  return rows.map(toRunWorktreeRecord);
}

export function markRunWorktreeRemoved(
  db: AlphredDatabase,
  params: {
    runWorktreeId: number;
    occurredAt?: string;
  },
): RunWorktreeRecord {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const updated = db
    .update(runWorktrees)
    .set({
      status: 'removed',
      removedAt: occurredAt,
    })
    .where(and(eq(runWorktrees.id, params.runWorktreeId), eq(runWorktrees.status, 'active')))
    .run();

  if (updated.changes !== 1) {
    throw new Error(
      `Run-worktree removal precondition failed for id=${params.runWorktreeId}; expected status "active".`,
    );
  }

  const runWorktree = getRunWorktreeById(db, params.runWorktreeId);
  if (!runWorktree) {
    throw new Error(`Run-worktree disappeared after removal update for id=${params.runWorktreeId}.`);
  }

  return runWorktree;
}
