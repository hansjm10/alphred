import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
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

export type RepositoryQueryOptions = {
  includeArchived?: boolean;
};

function shouldIncludeArchived(options: RepositoryQueryOptions | undefined, defaultValue: boolean): boolean {
  return options?.includeArchived ?? defaultValue;
}

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
    archivedAt: row.archivedAt,
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
  const created = getRepositoryById(db, repositoryId, { includeArchived: true });
  if (!created) {
    throw new Error(`Repository insert did not return a row for id=${repositoryId}.`);
  }

  return created;
}

export function getRepositoryById(
  db: AlphredDatabase,
  repositoryId: number,
  options?: RepositoryQueryOptions,
): RepositoryConfig | null {
  const includeArchived = shouldIncludeArchived(options, true);
  const row = db
    .select()
    .from(repositories)
    .where(
      includeArchived
        ? eq(repositories.id, repositoryId)
        : and(eq(repositories.id, repositoryId), isNull(repositories.archivedAt)),
    )
    .get();

  if (!row) {
    return null;
  }

  return toRepositoryConfig(row);
}

export function getRepositoryByName(
  db: AlphredDatabase,
  name: string,
  options?: RepositoryQueryOptions,
): RepositoryConfig | null {
  const includeArchived = shouldIncludeArchived(options, true);
  const row = db
    .select()
    .from(repositories)
    .where(includeArchived ? eq(repositories.name, name) : and(eq(repositories.name, name), isNull(repositories.archivedAt)))
    .get();

  if (!row) {
    return null;
  }

  return toRepositoryConfig(row);
}

export function listRepositories(db: AlphredDatabase, options?: RepositoryQueryOptions): RepositoryConfig[] {
  const includeArchived = shouldIncludeArchived(options, false);
  const rows = includeArchived
    ? db
        .select()
        .from(repositories)
        .orderBy(asc(repositories.name), asc(repositories.id))
        .all()
    : db
        .select()
        .from(repositories)
        .where(isNull(repositories.archivedAt))
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
    defaultBranch?: string;
    occurredAt?: string;
  },
): RepositoryConfig {
  assertKnownCloneStatus(params.cloneStatus);

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const updateValues: {
    cloneStatus: CloneStatus;
    updatedAt: string;
    localPath?: string | null;
    defaultBranch?: string;
  } = {
    cloneStatus: params.cloneStatus,
    updatedAt: occurredAt,
  };

  if (params.localPath !== undefined) {
    updateValues.localPath = params.localPath;
  }
  if (params.defaultBranch !== undefined) {
    updateValues.defaultBranch = params.defaultBranch;
  }

  const updated = db
    .update(repositories)
    .set(updateValues)
    .where(eq(repositories.id, params.repositoryId))
    .run();

  if (updated.changes !== 1) {
    throw new Error(`Repository clone-status update precondition failed for id=${params.repositoryId}.`);
  }

  const repository = getRepositoryById(db, params.repositoryId, { includeArchived: true });
  if (!repository) {
    throw new Error(`Repository disappeared after clone-status update for id=${params.repositoryId}.`);
  }

  return repository;
}

export function archiveRepository(
  db: AlphredDatabase,
  params: {
    repositoryId: number;
    occurredAt?: string;
  },
): RepositoryConfig {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const updated = db
    .update(repositories)
    .set({
      archivedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(and(eq(repositories.id, params.repositoryId), isNull(repositories.archivedAt)))
    .run();

  if (updated.changes !== 1) {
    throw new Error(`Repository archive precondition failed for id=${params.repositoryId}.`);
  }

  const repository = getRepositoryById(db, params.repositoryId, { includeArchived: true });
  if (!repository) {
    throw new Error(`Repository disappeared after archive for id=${params.repositoryId}.`);
  }

  return repository;
}

export function restoreRepository(
  db: AlphredDatabase,
  params: {
    repositoryId: number;
    occurredAt?: string;
  },
): RepositoryConfig {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const updated = db
    .update(repositories)
    .set({
      archivedAt: null,
      updatedAt: occurredAt,
    })
    .where(and(eq(repositories.id, params.repositoryId), isNotNull(repositories.archivedAt)))
    .run();

  if (updated.changes !== 1) {
    throw new Error(`Repository restore precondition failed for id=${params.repositoryId}.`);
  }

  const repository = getRepositoryById(db, params.repositoryId, { includeArchived: true });
  if (!repository) {
    throw new Error(`Repository disappeared after restore for id=${params.repositoryId}.`);
  }

  return repository;
}
