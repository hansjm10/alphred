import { asc, eq } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import { storyWorkspaces } from './schema.js';

type StoryWorkspaceRow = typeof storyWorkspaces.$inferSelect;

export type StoryWorkspaceRecord = {
  id: number;
  repositoryId: number;
  storyWorkItemId: number;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitHash: string | null;
  createdAt: string;
  updatedAt: string;
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

function toStoryWorkspaceRecord(row: StoryWorkspaceRow): StoryWorkspaceRecord {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    storyWorkItemId: row.storyWorkItemId,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    baseCommitHash: row.baseCommitHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function insertStoryWorkspace(db: AlphredDatabase, params: InsertStoryWorkspaceParams): StoryWorkspaceRecord {
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
      createdAt: occurredAt,
      updatedAt: occurredAt,
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
