import { constants } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  and,
  eq,
  getRepositoryById,
  getStoryWorkspaceByStoryWorkItemId,
  insertStoryWorkspace,
  updateStoryWorkspace,
  workItems,
  type AlphredDatabase,
  type StoryWorkspaceRecord,
} from '@alphred/db';
import {
  createWorktree,
  deleteBranch,
  ensureRepositoryClone,
  generateConfiguredBranchName,
  listWorktrees,
  removeWorktree,
  resolveSandboxDir,
} from '@alphred/git';
import type {
  DashboardCleanupStoryWorkspaceRequest,
  DashboardCleanupStoryWorkspaceResult,
  DashboardCreateStoryWorkspaceRequest,
  DashboardCreateStoryWorkspaceResult,
  DashboardGetStoryWorkspaceRequest,
  DashboardGetStoryWorkspaceResult,
  DashboardReconcileStoryWorkspaceRequest,
  DashboardReconcileStoryWorkspaceResult,
  DashboardRecreateStoryWorkspaceRequest,
  DashboardRecreateStoryWorkspaceResult,
  DashboardStoryWorkspaceSnapshot,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

type StoryWorkItemRecord = {
  id: number;
  repositoryId: number;
  status: string;
};

export type StoryWorkspaceOperationsDependencies = {
  ensureRepositoryClone: typeof ensureRepositoryClone;
  createWorktree?: typeof createWorktree;
  listWorktrees?: typeof listWorktrees;
  removeWorktree?: typeof removeWorktree;
  deleteBranch?: typeof deleteBranch;
  pathExists?: (path: string) => Promise<boolean>;
  removePath?: (path: string) => Promise<void>;
  now?: () => string;
};

export type StoryWorkspaceOperations = {
  getStoryWorkspace: (request: DashboardGetStoryWorkspaceRequest) => Promise<DashboardGetStoryWorkspaceResult>;
  createStoryWorkspace: (request: DashboardCreateStoryWorkspaceRequest) => Promise<DashboardCreateStoryWorkspaceResult>;
  reconcileStoryWorkspace: (
    request: DashboardReconcileStoryWorkspaceRequest,
  ) => Promise<DashboardReconcileStoryWorkspaceResult>;
  cleanupStoryWorkspace: (request: DashboardCleanupStoryWorkspaceRequest) => Promise<DashboardCleanupStoryWorkspaceResult>;
  recreateStoryWorkspace: (
    request: DashboardRecreateStoryWorkspaceRequest,
  ) => Promise<DashboardRecreateStoryWorkspaceResult>;
};

const STORY_WORKSPACE_TREE_KEY = 'story-workspace';
const STORY_WORKSPACE_BRANCH_TEMPLATE = 'alphred/story/{run-id}-{short-hash}';
const TERMINAL_STORY_STATUSES = new Set(['Done']);

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DashboardIntegrationError('invalid_request', `${label} must be a positive integer.`, {
      status: 400,
    });
  }

  return value;
}

function normalizeFsPath(path: string): string {
  return resolve(path);
}

function assertKnownStoryWorkspaceStatusReason(
  reason: string | null,
): asserts reason is DashboardStoryWorkspaceSnapshot['statusReason'] {
  if (
    reason !== null
    && reason !== 'missing_path'
    && reason !== 'worktree_not_registered'
    && reason !== 'branch_mismatch'
    && reason !== 'repository_clone_missing'
    && reason !== 'reconcile_failed'
    && reason !== 'removed_state_drift'
    && reason !== 'cleanup_requested'
  ) {
    throw new Error(`Unknown story workspace status reason: ${reason}`);
  }
}

function toStoryWorkspaceSnapshot(record: StoryWorkspaceRecord): DashboardStoryWorkspaceSnapshot {
  assertKnownStoryWorkspaceStatusReason(record.statusReason);

  return {
    id: record.id,
    repositoryId: record.repositoryId,
    storyId: record.storyWorkItemId,
    path: record.worktreePath,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommitHash: record.baseCommitHash,
    status: record.status,
    statusReason: record.statusReason,
    lastReconciledAt: record.lastReconciledAt,
    removedAt: record.removedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function requireStoryWorkItem(
  db: AlphredDatabase,
  params: {
    repositoryId: number;
    storyId: number;
  },
): StoryWorkItemRecord {
  const row = db
    .select({
      id: workItems.id,
      repositoryId: workItems.repositoryId,
      status: workItems.status,
      type: workItems.type,
    })
    .from(workItems)
    .where(and(eq(workItems.repositoryId, params.repositoryId), eq(workItems.id, params.storyId)))
    .get();

  if (!row) {
    throw new DashboardIntegrationError('not_found', `Story id=${params.storyId} was not found.`, {
      status: 404,
    });
  }

  if (row.type !== 'story') {
    throw new DashboardIntegrationError('invalid_request', `Work item id=${params.storyId} is not a story.`, {
      status: 400,
    });
  }

  return {
    id: row.id,
    repositoryId: row.repositoryId,
    status: row.status,
  };
}

function requireRepository(db: AlphredDatabase, repositoryId: number) {
  const repository = getRepositoryById(db, repositoryId, { includeArchived: true });
  if (!repository) {
    throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
      status: 404,
    });
  }

  return repository;
}

function requireStoryWorkspace(db: AlphredDatabase, storyId: number): StoryWorkspaceRecord {
  const workspace = getStoryWorkspaceByStoryWorkItemId(db, storyId);
  if (!workspace) {
    throw new DashboardIntegrationError('not_found', `Story workspace for story id=${storyId} was not found.`, {
      status: 404,
    });
  }

  return workspace;
}

function assertStoryWorkspaceCreatable(params: {
  repositoryName: string;
  repositoryArchivedAt: string | null;
  storyId: number;
  storyStatus: string;
}): void {
  if (params.repositoryArchivedAt !== null) {
    throw new DashboardIntegrationError(
      'conflict',
      `Repository "${params.repositoryName}" is archived. Restore it before creating or recreating a story workspace.`,
      {
        status: 409,
        details: {
          storyId: params.storyId,
          archivedAt: params.repositoryArchivedAt,
        },
      },
    );
  }

  if (TERMINAL_STORY_STATUSES.has(params.storyStatus)) {
    throw new DashboardIntegrationError(
      'conflict',
      `Story id=${params.storyId} is already ${params.storyStatus}. Clean up the workspace instead of creating a new one.`,
      {
        status: 409,
        details: {
          storyId: params.storyId,
          storyStatus: params.storyStatus,
        },
      },
    );
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultRemovePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function toCleanupConflict(message: string, details: Record<string, unknown>, cause?: unknown): DashboardIntegrationError {
  return new DashboardIntegrationError('conflict', message, {
    status: 409,
    details,
    cause,
  });
}

function toRecreateConflict(workspace: StoryWorkspaceRecord): DashboardIntegrationError {
  return new DashboardIntegrationError(
    'conflict',
    `Story workspace for story id=${workspace.storyWorkItemId} must be removed before it can be recreated.`,
    {
      status: 409,
      details: {
        storyWorkspaceId: workspace.id,
        storyId: workspace.storyWorkItemId,
        currentStatus: workspace.status,
        allowedStatuses: ['removed'],
      },
    },
  );
}

function markWorkspaceRemovedStateDrift(
  db: AlphredDatabase,
  workspace: StoryWorkspaceRecord,
  occurredAt: string,
): StoryWorkspaceRecord {
  return updateStoryWorkspace(db, {
    storyWorkspaceId: workspace.id,
    status: 'stale',
    statusReason: 'removed_state_drift',
    lastReconciledAt: occurredAt,
    removedAt: null,
    occurredAt,
  });
}

function createFreshStoryWorkspace(
  params: {
    db: AlphredDatabase;
    repositoryId: number;
    repositoryName: string;
    repositoryProvider: 'github' | 'azure-devops';
    repositoryRemoteUrl: string;
    repositoryRemoteRef: string;
    repositoryDefaultBranch: string;
    storyId: number;
    environment: NodeJS.ProcessEnv;
    worktreeBase: string;
    ensureRepositoryClone: StoryWorkspaceOperationsDependencies['ensureRepositoryClone'];
    createStoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['createWorktree']>;
    existingWorkspace: StoryWorkspaceRecord | null;
    occurredAt: string;
  },
) {
  return (async () => {
    const ensured = await params.ensureRepositoryClone({
      db: params.db,
      repository: {
        name: params.repositoryName,
        provider: params.repositoryProvider,
        remoteUrl: params.repositoryRemoteUrl,
        remoteRef: params.repositoryRemoteRef,
        defaultBranch: params.repositoryDefaultBranch,
      },
      environment: params.environment,
    });
    const clonedRepository = ensured.repository;
    if (!clonedRepository.localPath) {
      throw new DashboardIntegrationError(
        'internal_error',
        `Repository "${clonedRepository.name}" does not have a local clone path.`,
        {
          status: 500,
        },
      );
    }

    const baseBranch = clonedRepository.defaultBranch.trim().length > 0 ? clonedRepository.defaultBranch : 'main';
    const branch = generateConfiguredBranchName(
      {
        treeKey: STORY_WORKSPACE_TREE_KEY,
        runId: params.storyId,
      },
      STORY_WORKSPACE_BRANCH_TEMPLATE,
    );

    let createdWorktree: Awaited<ReturnType<NonNullable<StoryWorkspaceOperationsDependencies['createWorktree']>>>;
    try {
      createdWorktree = await params.createStoryWorktree(clonedRepository.localPath, params.worktreeBase, {
        branch,
        baseRef: baseBranch,
      });
    } catch (error) {
      throw new DashboardIntegrationError(
        'conflict',
        `Unable to create story workspace for story id=${params.storyId}.`,
        {
          status: 409,
          details: {
            repositoryId: clonedRepository.id,
            storyId: params.storyId,
            branch,
          },
          cause: error,
        },
      );
    }

    if (params.existingWorkspace) {
      return updateStoryWorkspace(params.db, {
        storyWorkspaceId: params.existingWorkspace.id,
        worktreePath: createdWorktree.path,
        branch: createdWorktree.branch,
        baseBranch,
        baseCommitHash: createdWorktree.commit,
        status: 'active',
        statusReason: null,
        lastReconciledAt: params.occurredAt,
        removedAt: null,
        occurredAt: params.occurredAt,
      });
    }

    return insertStoryWorkspace(params.db, {
      repositoryId: params.repositoryId,
      storyWorkItemId: params.storyId,
      worktreePath: createdWorktree.path,
      branch: createdWorktree.branch,
      baseBranch,
      baseCommitHash: createdWorktree.commit,
      occurredAt: params.occurredAt,
    });
  })();
}

async function reconcileWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    removeRepositoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
    deleteRepositoryBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    removePath: NonNullable<StoryWorkspaceOperationsDependencies['removePath']>;
    occurredAt: string;
  },
): Promise<StoryWorkspaceRecord> {
  if (params.workspace.status === 'removed') {
    try {
      return await cleanupWorkspaceRecord(db, {
        repositoryLocalPath: params.repositoryLocalPath,
        workspace: params.workspace,
        listRepositoryWorktrees: params.listRepositoryWorktrees,
        removeRepositoryWorktree: params.removeRepositoryWorktree,
        deleteRepositoryBranch: params.deleteRepositoryBranch,
        pathExists: params.pathExists,
        removePath: params.removePath,
        occurredAt: params.occurredAt,
        allowRemovedWorkspaceRepair: true,
        removedAtOnSuccess: params.workspace.removedAt ?? params.occurredAt,
      });
    } catch {
      return markWorkspaceRemovedStateDrift(db, params.workspace, params.occurredAt);
    }
  }

  if (!params.repositoryLocalPath) {
    return updateStoryWorkspace(db, {
      storyWorkspaceId: params.workspace.id,
      status: 'stale',
      statusReason: 'repository_clone_missing',
      lastReconciledAt: params.occurredAt,
      removedAt: null,
      occurredAt: params.occurredAt,
    });
  }

  let worktreeEntries: Awaited<ReturnType<NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>>>;
  try {
    worktreeEntries = await params.listRepositoryWorktrees(params.repositoryLocalPath);
  } catch {
    return updateStoryWorkspace(db, {
      storyWorkspaceId: params.workspace.id,
      status: 'stale',
      statusReason: 'reconcile_failed',
      lastReconciledAt: params.occurredAt,
      removedAt: null,
      occurredAt: params.occurredAt,
    });
  }

  const matchingWorktree = worktreeEntries.find(
    entry => normalizeFsPath(entry.path) === normalizeFsPath(params.workspace.worktreePath),
  );
  const pathExists = await params.pathExists(params.workspace.worktreePath);

  if (matchingWorktree) {
    if (matchingWorktree.branch !== params.workspace.branch) {
      return updateStoryWorkspace(db, {
        storyWorkspaceId: params.workspace.id,
        status: 'stale',
        statusReason: 'branch_mismatch',
        lastReconciledAt: params.occurredAt,
        removedAt: null,
        occurredAt: params.occurredAt,
      });
    }

    if (!pathExists) {
      return updateStoryWorkspace(db, {
        storyWorkspaceId: params.workspace.id,
        status: 'stale',
        statusReason: 'missing_path',
        lastReconciledAt: params.occurredAt,
        removedAt: null,
        occurredAt: params.occurredAt,
      });
    }

    return updateStoryWorkspace(db, {
      storyWorkspaceId: params.workspace.id,
      status: 'active',
      statusReason: null,
      lastReconciledAt: params.occurredAt,
      removedAt: null,
      occurredAt: params.occurredAt,
    });
  }

  return updateStoryWorkspace(db, {
    storyWorkspaceId: params.workspace.id,
    status: 'stale',
    statusReason: pathExists ? 'worktree_not_registered' : 'missing_path',
    lastReconciledAt: params.occurredAt,
    removedAt: null,
    occurredAt: params.occurredAt,
  });
}

async function cleanupWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    removeRepositoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
    deleteRepositoryBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    removePath: NonNullable<StoryWorkspaceOperationsDependencies['removePath']>;
    occurredAt: string;
    allowRemovedWorkspaceRepair?: boolean;
    removedAtOnSuccess?: string | null;
  },
): Promise<StoryWorkspaceRecord> {
  if (params.workspace.status === 'removed' && params.allowRemovedWorkspaceRepair !== true) {
    return params.workspace;
  }

  const getRegisteredWorktreeState = async (): Promise<'registered' | 'unregistered' | 'unknown'> => {
    if (!params.repositoryLocalPath) {
      return 'unregistered';
    }

    try {
      const worktrees = await params.listRepositoryWorktrees(params.repositoryLocalPath);
      return worktrees.some(entry => normalizeFsPath(entry.path) === normalizeFsPath(params.workspace.worktreePath))
        ? 'registered'
        : 'unregistered';
    } catch {
      return 'unknown';
    }
  };

  let cleanupError: unknown = null;
  const registeredStateBeforeRemoval = await getRegisteredWorktreeState();
  const pathExistsBeforeRemoval = await params.pathExists(params.workspace.worktreePath);

  if (registeredStateBeforeRemoval !== 'unregistered' && params.repositoryLocalPath) {
    try {
      await params.removeRepositoryWorktree(params.repositoryLocalPath, params.workspace.worktreePath);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (pathExistsBeforeRemoval) {
    try {
      await params.removePath(params.workspace.worktreePath);
    } catch (error) {
      if (cleanupError === null) {
        cleanupError = error;
      }
    }
  }

  const registeredStateAfterRemoval =
    registeredStateBeforeRemoval === 'unregistered' ? 'unregistered' : await getRegisteredWorktreeState();
  const pathExistsAfterRemoval = await params.pathExists(params.workspace.worktreePath);
  const gitCleanupUnverified = registeredStateAfterRemoval === 'unknown';
  const worktreeStillRegistered = registeredStateAfterRemoval === 'registered';

  if (pathExistsAfterRemoval || worktreeStillRegistered || gitCleanupUnverified) {
    throw toCleanupConflict(
      `Unable to clean up story workspace for story id=${params.workspace.storyWorkItemId}.`,
      {
        storyWorkspaceId: params.workspace.id,
        storyId: params.workspace.storyWorkItemId,
        worktreePath: params.workspace.worktreePath,
      },
      cleanupError,
    );
  }

  if (params.repositoryLocalPath) {
    try {
      await params.deleteRepositoryBranch(params.repositoryLocalPath, params.workspace.branch);
    } catch {
      // Branch deletion is best-effort; cleanup still succeeds once the workspace record is retired.
    }
  }

  return updateStoryWorkspace(db, {
    storyWorkspaceId: params.workspace.id,
    status: 'removed',
    statusReason: 'cleanup_requested',
    lastReconciledAt: params.occurredAt,
    removedAt: params.removedAtOnSuccess ?? params.occurredAt,
    occurredAt: params.occurredAt,
  });
}

export function createStoryWorkspaceOperations(params: {
  withDatabase: WithDatabase;
  dependencies: StoryWorkspaceOperationsDependencies;
  environment: NodeJS.ProcessEnv;
}): StoryWorkspaceOperations {
  const { withDatabase, dependencies, environment } = params;
  const createStoryWorktree = dependencies.createWorktree ?? createWorktree;
  const listRepositoryWorktrees = dependencies.listWorktrees ?? listWorktrees;
  const removeRepositoryWorktree = dependencies.removeWorktree ?? removeWorktree;
  const deleteRepositoryBranch = dependencies.deleteBranch ?? deleteBranch;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const removePath = dependencies.removePath ?? defaultRemovePath;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const worktreeBase = join(resolveSandboxDir(environment), 'worktrees');

  return {
    getStoryWorkspace(requestRaw): Promise<DashboardGetStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        const workspace = getStoryWorkspaceByStoryWorkItemId(db, storyId);
        if (!workspace) {
          return {
            workspace: null,
          };
        }

        const reconciled = await reconcileWorkspaceRecord(db, {
          repositoryLocalPath: repository.localPath,
          workspace,
          listRepositoryWorktrees,
          removeRepositoryWorktree,
          deleteRepositoryBranch,
          pathExists,
          removePath,
          occurredAt: now(),
        });
        return {
          workspace: toStoryWorkspaceSnapshot(reconciled),
        };
      });
    },

    createStoryWorkspace(requestRaw): Promise<DashboardCreateStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        const story = requireStoryWorkItem(db, {
          repositoryId,
          storyId,
        });
        const repository = requireRepository(db, repositoryId);
        const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(db, story.id);
        if (existingWorkspace) {
          const reconciled = await reconcileWorkspaceRecord(db, {
            repositoryLocalPath: repository.localPath,
            workspace: existingWorkspace,
            listRepositoryWorktrees,
            removeRepositoryWorktree,
            deleteRepositoryBranch,
            pathExists,
            removePath,
            occurredAt: now(),
          });
          return {
            workspace: toStoryWorkspaceSnapshot(reconciled),
            created: false,
          };
        }

        assertStoryWorkspaceCreatable({
          repositoryName: repository.name,
          repositoryArchivedAt: repository.archivedAt,
          storyId: story.id,
          storyStatus: story.status,
        });

        const created = await createFreshStoryWorkspace({
          db,
          repositoryId,
          repositoryName: repository.name,
          repositoryProvider: repository.provider,
          repositoryRemoteUrl: repository.remoteUrl,
          repositoryRemoteRef: repository.remoteRef,
          repositoryDefaultBranch: repository.defaultBranch,
          storyId: story.id,
          environment,
          worktreeBase,
          ensureRepositoryClone: dependencies.ensureRepositoryClone,
          createStoryWorktree,
          existingWorkspace: null,
          occurredAt: now(),
        });

        return {
          workspace: toStoryWorkspaceSnapshot(created),
          created: true,
        };
      });
    },

    reconcileStoryWorkspace(requestRaw): Promise<DashboardReconcileStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        const workspace = requireStoryWorkspace(db, storyId);
        const reconciled = await reconcileWorkspaceRecord(db, {
          repositoryLocalPath: repository.localPath,
          workspace,
          listRepositoryWorktrees,
          removeRepositoryWorktree,
          deleteRepositoryBranch,
          pathExists,
          removePath,
          occurredAt: now(),
        });
        return {
          workspace: toStoryWorkspaceSnapshot(reconciled),
        };
      });
    },

    cleanupStoryWorkspace(requestRaw): Promise<DashboardCleanupStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        const workspace = requireStoryWorkspace(db, storyId);
        if (workspace.status === 'removed') {
          const repaired = await reconcileWorkspaceRecord(db, {
            repositoryLocalPath: repository.localPath,
            workspace,
            listRepositoryWorktrees,
            removeRepositoryWorktree,
            deleteRepositoryBranch,
            pathExists,
            removePath,
            occurredAt: now(),
          });
          if (repaired.status !== 'removed') {
            throw toCleanupConflict(
              `Unable to clean up story workspace for story id=${workspace.storyWorkItemId}.`,
              {
                storyWorkspaceId: workspace.id,
                storyId: workspace.storyWorkItemId,
                worktreePath: workspace.worktreePath,
              },
            );
          }
          return {
            workspace: toStoryWorkspaceSnapshot(repaired),
          };
        }

        const cleaned = await cleanupWorkspaceRecord(db, {
          repositoryLocalPath: repository.localPath,
          workspace,
          listRepositoryWorktrees,
          removeRepositoryWorktree,
          deleteRepositoryBranch,
          pathExists,
          removePath,
          occurredAt: now(),
        });
        return {
          workspace: toStoryWorkspaceSnapshot(cleaned),
        };
      });
    },

    recreateStoryWorkspace(requestRaw): Promise<DashboardRecreateStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        const story = requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        assertStoryWorkspaceCreatable({
          repositoryName: repository.name,
          repositoryArchivedAt: repository.archivedAt,
          storyId: story.id,
          storyStatus: story.status,
        });

        const existingWorkspace = requireStoryWorkspace(db, storyId);
        const occurredAt = now();
        const reconciled = await reconcileWorkspaceRecord(db, {
          repositoryLocalPath: repository.localPath,
          workspace: existingWorkspace,
          listRepositoryWorktrees,
          removeRepositoryWorktree,
          deleteRepositoryBranch,
          pathExists,
          removePath,
          occurredAt,
        });
        if (reconciled.status !== 'removed') {
          throw toRecreateConflict(reconciled);
        }
        const recreated = await createFreshStoryWorkspace({
          db,
          repositoryId,
          repositoryName: repository.name,
          repositoryProvider: repository.provider,
          repositoryRemoteUrl: repository.remoteUrl,
          repositoryRemoteRef: repository.remoteRef,
          repositoryDefaultBranch: repository.defaultBranch,
          storyId: story.id,
          environment,
          worktreeBase,
          ensureRepositoryClone: dependencies.ensureRepositoryClone,
          createStoryWorktree,
          existingWorkspace: reconciled,
          occurredAt,
        });

        return {
          workspace: toStoryWorkspaceSnapshot(recreated),
        };
      });
    },
  };
}
