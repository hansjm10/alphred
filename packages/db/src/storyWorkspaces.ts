import { asc, eq } from 'drizzle-orm';
import {
  storyWorkspaceStatusReasons,
  storyWorkspaceStatuses,
  type StoryWorkspaceStatus,
  type StoryWorkspaceStatusReason,
} from '@alphred/shared';
import type { AlphredDatabase } from './connection.js';
import { storyWorkspaces, workItems } from './schema.js';

type StoryWorkspaceRow = typeof storyWorkspaces.$inferSelect;

export type StoryWorkspaceRecord = {
  id: number;
  repositoryId: number;
  storyWorkItemId: number;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitHash: string | null;
  status: StoryWorkspaceStatus;
  statusReason: StoryWorkspaceStatusReason | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
};

export type InsertStoryWorkspaceParams = {
  repositoryId: number;
  storyWorkItemId: number;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitHash?: string | null;
  occurredAt?: string;
};

export type UpdateStoryWorkspaceParams = {
  storyWorkspaceId: number;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommitHash?: string | null;
  status?: StoryWorkspaceStatus;
  statusReason?: StoryWorkspaceStatusReason | null;
  lastReconciledAt?: string | null;
  removedAt?: string | null;
  occurredAt?: string;
};

type StoryWorkspaceMaterialState = Pick<
  StoryWorkspaceRecord,
  'worktreePath' | 'branch' | 'baseBranch' | 'baseCommitHash' | 'status' | 'statusReason' | 'removedAt'
>;

type StoryWorkspaceUpdateValues = {
  updatedAt: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommitHash?: string | null;
  status?: StoryWorkspaceStatus;
  statusReason?: StoryWorkspaceStatusReason | null;
  lastReconciledAt?: string | null;
  removedAt?: string | null;
};

function assertKnownStoryWorkspaceStatus(status: string): asserts status is StoryWorkspaceStatus {
  if (!storyWorkspaceStatuses.includes(status as StoryWorkspaceStatus)) {
    throw new Error(`Unknown story-workspace status: ${status}`);
  }
}

function assertKnownStoryWorkspaceStatusReason(reason: string | null): asserts reason is StoryWorkspaceStatusReason | null {
  if (reason !== null && !storyWorkspaceStatusReasons.includes(reason as StoryWorkspaceStatusReason)) {
    throw new Error(`Unknown story-workspace status reason: ${reason}`);
  }
}

function assertStoryWorkspaceLifecycleCompatibility(
  status: StoryWorkspaceStatus,
  statusReason: StoryWorkspaceStatusReason | null,
): void {
  if (status === 'active' && statusReason !== null) {
    throw new Error(`Story workspace status "active" requires statusReason to be null; received ${statusReason}.`);
  }
}

function didStoryWorkspaceMaterialStateChange(
  current: StoryWorkspaceMaterialState,
  next: StoryWorkspaceMaterialState,
): boolean {
  return (
    current.worktreePath !== next.worktreePath ||
    current.branch !== next.branch ||
    current.baseBranch !== next.baseBranch ||
    current.baseCommitHash !== next.baseCommitHash ||
    current.status !== next.status ||
    current.statusReason !== next.statusReason ||
    current.removedAt !== next.removedAt
  );
}

function resolveStoryWorkspaceStatusReason(
  statusReason: UpdateStoryWorkspaceParams['statusReason'],
): StoryWorkspaceStatusReason | null | undefined {
  if (statusReason === undefined) {
    return undefined;
  }

  return statusReason ?? null;
}

function buildNextStoryWorkspaceMaterialState(
  current: StoryWorkspaceRecord,
  params: UpdateStoryWorkspaceParams,
  resolvedStatusReason: StoryWorkspaceStatusReason | null | undefined,
): StoryWorkspaceMaterialState {
  return {
    worktreePath: params.worktreePath ?? current.worktreePath,
    branch: params.branch ?? current.branch,
    baseBranch: params.baseBranch ?? current.baseBranch,
    baseCommitHash: 'baseCommitHash' in params ? (params.baseCommitHash ?? null) : current.baseCommitHash,
    status: params.status ?? current.status,
    statusReason: resolvedStatusReason === undefined ? current.statusReason : resolvedStatusReason,
    removedAt: 'removedAt' in params ? (params.removedAt ?? null) : current.removedAt,
  };
}

function buildStoryWorkspaceUpdateValues(
  current: StoryWorkspaceRecord,
  params: UpdateStoryWorkspaceParams,
  nextMaterialState: StoryWorkspaceMaterialState,
  resolvedStatusReason: StoryWorkspaceStatusReason | null | undefined,
  occurredAt: string,
): StoryWorkspaceUpdateValues {
  const values: StoryWorkspaceUpdateValues = {
    // `updatedAt` tracks material row changes. Reconciliation-only touches that
    // just advance `lastReconciledAt` keep the prior `updatedAt`.
    updatedAt: didStoryWorkspaceMaterialStateChange(current, nextMaterialState) ? occurredAt : current.updatedAt,
  };

  if ('worktreePath' in params) {
    values.worktreePath = params.worktreePath;
  }
  if ('branch' in params) {
    values.branch = params.branch;
  }
  if ('baseBranch' in params) {
    values.baseBranch = params.baseBranch;
  }
  if ('baseCommitHash' in params) {
    values.baseCommitHash = params.baseCommitHash ?? null;
  }
  if (params.status !== undefined) {
    values.status = params.status;
  }
  if (resolvedStatusReason !== undefined) {
    values.statusReason = resolvedStatusReason;
  }
  if ('lastReconciledAt' in params) {
    values.lastReconciledAt = params.lastReconciledAt ?? null;
  }
  if ('removedAt' in params) {
    values.removedAt = params.removedAt ?? null;
  }

  return values;
}

function toStoryWorkspaceRecord(row: StoryWorkspaceRow): StoryWorkspaceRecord {
  assertKnownStoryWorkspaceStatus(row.status);
  assertKnownStoryWorkspaceStatusReason(row.statusReason);
  assertStoryWorkspaceLifecycleCompatibility(row.status, row.statusReason);

  return {
    id: row.id,
    repositoryId: row.repositoryId,
    storyWorkItemId: row.storyWorkItemId,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommitHash: row.baseCommitHash,
    status: row.status,
    statusReason: row.statusReason,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    removedAt: row.removedAt,
  };
}

export function insertStoryWorkspace(db: AlphredDatabase, params: InsertStoryWorkspaceParams): StoryWorkspaceRecord {
  const storyWorkItem = db
    .select({
      repositoryId: workItems.repositoryId,
      type: workItems.type,
    })
    .from(workItems)
    .where(eq(workItems.id, params.storyWorkItemId))
    .get();

  if (!storyWorkItem) {
    throw new Error(
      `Story workspace insert precondition failed for storyWorkItemId=${params.storyWorkItemId}; expected an existing story work item.`,
    );
  }
  if (storyWorkItem.type !== 'story') {
    throw new Error(
      `Story workspace insert precondition failed for storyWorkItemId=${params.storyWorkItemId}; expected work_item.type "story".`,
    );
  }
  if (storyWorkItem.repositoryId !== params.repositoryId) {
    throw new Error(
      `Story workspace insert precondition failed for storyWorkItemId=${params.storyWorkItemId}; expected repositoryId=${storyWorkItem.repositoryId}.`,
    );
  }

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const inserted = db
    .insert(storyWorkspaces)
    .values({
      repositoryId: params.repositoryId,
      storyWorkItemId: params.storyWorkItemId,
      worktreePath: params.worktreePath,
      branch: params.branch,
      baseBranch: params.baseBranch,
      baseCommitHash: params.baseCommitHash ?? null,
      status: 'active',
      statusReason: null,
      lastReconciledAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      removedAt: null,
    })
    .run();

  const storyWorkspaceId = Number(inserted.lastInsertRowid);
  const created = getStoryWorkspaceById(db, storyWorkspaceId);
  if (!created) {
    throw new Error(`Story workspace insert did not return a row for id=${storyWorkspaceId}.`);
  }

  return created;
}

export function getStoryWorkspaceById(db: AlphredDatabase, storyWorkspaceId: number): StoryWorkspaceRecord | null {
  const row = db
    .select()
    .from(storyWorkspaces)
    .where(eq(storyWorkspaces.id, storyWorkspaceId))
    .get();

  if (!row) {
    return null;
  }

  return toStoryWorkspaceRecord(row);
}

export function getStoryWorkspaceByStoryWorkItemId(
  db: AlphredDatabase,
  storyWorkItemId: number,
): StoryWorkspaceRecord | null {
  const row = db
    .select()
    .from(storyWorkspaces)
    .where(eq(storyWorkspaces.storyWorkItemId, storyWorkItemId))
    .get();

  if (!row) {
    return null;
  }

  return toStoryWorkspaceRecord(row);
}

export function listStoryWorkspacesForRepository(db: AlphredDatabase, repositoryId: number): StoryWorkspaceRecord[] {
  const rows = db
    .select()
    .from(storyWorkspaces)
    .where(eq(storyWorkspaces.repositoryId, repositoryId))
    .orderBy(asc(storyWorkspaces.createdAt), asc(storyWorkspaces.id))
    .all();

  return rows.map(toStoryWorkspaceRecord);
}

export function updateStoryWorkspace(db: AlphredDatabase, params: UpdateStoryWorkspaceParams): StoryWorkspaceRecord {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const current = getStoryWorkspaceById(db, params.storyWorkspaceId);
  if (!current) {
    throw new Error(`Story workspace id=${params.storyWorkspaceId} was not found for update.`);
  }

  if (params.status !== undefined) {
    assertKnownStoryWorkspaceStatus(params.status);
  }
  const resolvedStatusReason = resolveStoryWorkspaceStatusReason(params.statusReason);
  if (resolvedStatusReason !== undefined) {
    assertKnownStoryWorkspaceStatusReason(resolvedStatusReason);
  }

  const nextMaterialState = buildNextStoryWorkspaceMaterialState(current, params, resolvedStatusReason);
  assertStoryWorkspaceLifecycleCompatibility(nextMaterialState.status, nextMaterialState.statusReason);

  const values = buildStoryWorkspaceUpdateValues(
    current,
    params,
    nextMaterialState,
    resolvedStatusReason,
    occurredAt,
  );

  const updated = db
    .update(storyWorkspaces)
    .set(values)
    .where(eq(storyWorkspaces.id, params.storyWorkspaceId))
    .run();

  if (updated.changes !== 1) {
    throw new Error(`Story workspace id=${params.storyWorkspaceId} was not found for update.`);
  }

  const storyWorkspace = getStoryWorkspaceById(db, params.storyWorkspaceId);
  if (!storyWorkspace) {
    throw new Error(`Story workspace disappeared after update for id=${params.storyWorkspaceId}.`);
  }

  return storyWorkspace;
}
