import { asc, eq } from 'drizzle-orm';
import type { CloneStatus, RepositoryConfig, ScmProviderKind } from '@alphred/shared';
import type { AlphredDatabase } from './connection.js';
import { repositories } from './schema.js';

type RepositoryRow = typeof repositories.$inferSelect;

const providerKinds: ReadonlySet<ScmProviderKind> = new Set(['github', 'azure-devops']);
const cloneStatuses: ReadonlySet<CloneStatus> = new Set(['pending', 'cloned', 'error']);

export type InsertRepositoryParams = {
  name: string;
  provider: ScmProviderKind;
  remoteUrl: string;
  remoteRef: string;
  defaultBranch?: string;
  branchTemplate?: string | null;
  localPath?: string | null;
  cloneStatus?: CloneStatus;
  occurredAt?: string;
};

function assertKnownProvider(provider: string): asserts provider is ScmProviderKind {
  if (!providerKinds.has(provider as ScmProviderKind)) {
    throw new Error(`Unknown SCM provider: ${provider}`);
  }
}

function assertKnownCloneStatus(cloneStatus: string): asserts cloneStatus is CloneStatus {
  if (!cloneStatuses.has(cloneStatus as CloneStatus)) {
    throw new Error(`Unknown clone status: ${cloneStatus}`);
  }
}

function toRepositoryConfig(row: RepositoryRow): RepositoryConfig {
  assertKnownProvider(row.provider);
  assertKnownCloneStatus(row.cloneStatus);

  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    remoteUrl: row.remoteUrl,
    remoteRef: row.remoteRef,
    defaultBranch: row.defaultBranch,
    branchTemplate: row.branchTemplate,
    localPath: row.localPath,
    cloneStatus: row.cloneStatus,
  };
}

export function insertRepository(db: AlphredDatabase, params: InsertRepositoryParams): RepositoryConfig {
  assertKnownProvider(params.provider);
  const cloneStatus = params.cloneStatus ?? 'pending';
  assertKnownCloneStatus(cloneStatus);

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const inserted = db
    .insert(repositories)
    .values({
      name: params.name,
      provider: params.provider,
      remoteUrl: params.remoteUrl,
      remoteRef: params.remoteRef,
      defaultBranch: params.defaultBranch ?? 'main',
      branchTemplate: params.branchTemplate ?? null,
      localPath: params.localPath ?? null,
      cloneStatus,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    .run();

  const repositoryId = Number(inserted.lastInsertRowid);
  const created = getRepositoryById(db, repositoryId);
  if (!created) {
    throw new Error(`Repository insert did not return a row for id=${repositoryId}.`);
  }

  return created;
}

export function getRepositoryById(db: AlphredDatabase, repositoryId: number): RepositoryConfig | null {
  const row = db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .get();

  if (!row) {
    return null;
  }

  return toRepositoryConfig(row);
}

export function getRepositoryByName(db: AlphredDatabase, name: string): RepositoryConfig | null {
  const row = db
    .select()
    .from(repositories)
    .where(eq(repositories.name, name))
    .get();

  if (!row) {
    return null;
  }

  return toRepositoryConfig(row);
}

export function listRepositories(db: AlphredDatabase): RepositoryConfig[] {
  const rows = db
    .select()
    .from(repositories)
    .orderBy(asc(repositories.name), asc(repositories.id))
    .all();

  return rows.map(toRepositoryConfig);
}

export function updateRepositoryCloneStatus(
  db: AlphredDatabase,
  params: {
    repositoryId: number;
    cloneStatus: CloneStatus;
    localPath?: string | null;
    occurredAt?: string;
  },
): RepositoryConfig {
  assertKnownCloneStatus(params.cloneStatus);

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const updateValues: {
    cloneStatus: CloneStatus;
    updatedAt: string;
    localPath?: string | null;
  } = {
    cloneStatus: params.cloneStatus,
    updatedAt: occurredAt,
  };

  if (params.localPath !== undefined) {
    updateValues.localPath = params.localPath;
  }

  const updated = db
    .update(repositories)
    .set(updateValues)
    .where(eq(repositories.id, params.repositoryId))
    .run();

  if (updated.changes !== 1) {
    throw new Error(`Repository clone-status update precondition failed for id=${params.repositoryId}.`);
  }

  const repository = getRepositoryById(db, params.repositoryId);
  if (!repository) {
    throw new Error(`Repository disappeared after clone-status update for id=${params.repositoryId}.`);
  }

  return repository;
}
