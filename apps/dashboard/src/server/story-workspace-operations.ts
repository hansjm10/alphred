import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
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
  DashboardCreateStoryWorkspaceRequest,
  DashboardCreateStoryWorkspaceResult,
  DashboardGetStoryWorkspaceRequest,
  DashboardGetStoryWorkspaceResult,
  DashboardReconcileStoryWorkspaceRequest,
  DashboardReconcileStoryWorkspaceResult,
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
  removeWorktree?: typeof removeWorktree;
  deleteBranch?: typeof deleteBranch;
  listWorktrees?: typeof listWorktrees;
  pathExists?: (path: string) => Promise<boolean>;
  now?: () => string;
};

export type StoryWorkspaceOperations = {
  getStoryWorkspace: (request: DashboardGetStoryWorkspaceRequest) => Promise<DashboardGetStoryWorkspaceResult>;
  createStoryWorkspace: (request: DashboardCreateStoryWorkspaceRequest) => Promise<DashboardCreateStoryWorkspaceResult>;
  reconcileStoryWorkspace: (
    request: DashboardReconcileStoryWorkspaceRequest,
  ) => Promise<DashboardReconcileStoryWorkspaceResult>;
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

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toStoryWorkspaceSnapshot(record: StoryWorkspaceRecord) {
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
      `Repository "${params.repositoryName}" is archived. Restore it before creating a story workspace.`,
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
      `Story id=${params.storyId} is already ${params.storyStatus}. Story workspaces cannot be created for done stories.`,
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

function assertStoryWorkspaceDoesNotExistForCreate(params: {
  storyId: number;
  workspace: StoryWorkspaceRecord;
  cause?: unknown;
}): never {
  if (params.workspace.status === 'removed') {
    throw new DashboardIntegrationError(
      'conflict',
      `Story workspace for story id=${params.storyId} already exists in removed state.`,
      {
        status: 409,
        details: {
          storyId: params.storyId,
          currentStatus: params.workspace.status,
        },
        cause: params.cause,
      },
    );
  }

  throw new DashboardIntegrationError(
    'conflict',
    `Story workspace for story id=${params.storyId} already exists. Reconcile it instead of creating a new one.`,
    {
      status: 409,
      details: {
        storyId: params.storyId,
        currentStatus: params.workspace.status,
        allowedActions: ['reconcile'],
      },
      cause: params.cause,
    },
  );
}

function isStoryWorkspaceUniqueConstraintError(error: unknown): boolean {
  return readErrorMessage(error).toLowerCase().includes('unique constraint failed: story_workspaces.story_work_item_id');
}

async function rollbackCreatedStoryWorkspace(params: {
  repositoryId: number;
  storyId: number;
  repositoryLocalPath: string;
  createdWorktree: Awaited<ReturnType<typeof createWorktree>>;
  removeStoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
  deleteStoryWorktreeBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
  originalError: unknown;
}): Promise<void> {
  const rollbackErrors: unknown[] = [];

  try {
    await params.removeStoryWorktree(params.repositoryLocalPath, params.createdWorktree.path);
  } catch (removeError) {
    rollbackErrors.push(removeError);
  }

  try {
    await params.deleteStoryWorktreeBranch(params.repositoryLocalPath, params.createdWorktree.branch);
  } catch (deleteError) {
    rollbackErrors.push(deleteError);
  }

  if (rollbackErrors.length > 0) {
    throw new DashboardIntegrationError(
      'internal_error',
      `Unable to roll back story workspace create failure for story id=${params.storyId}.`,
      {
        status: 500,
        details: {
          repositoryId: params.repositoryId,
          storyId: params.storyId,
          branch: params.createdWorktree.branch,
          worktreePath: params.createdWorktree.path,
        },
        cause: new AggregateError([params.originalError, ...rollbackErrors], 'Story workspace create rollback failed.'),
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

async function createFreshStoryWorkspace(params: {
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
  removeStoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
  deleteStoryWorktreeBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
  occurredAt: string;
}): Promise<StoryWorkspaceRecord> {
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

  try {
    return insertStoryWorkspace(params.db, {
      repositoryId: params.repositoryId,
      storyWorkItemId: params.storyId,
      worktreePath: createdWorktree.path,
      branch: createdWorktree.branch,
      baseBranch,
      baseCommitHash: createdWorktree.commit,
      occurredAt: params.occurredAt,
    });
  } catch (error) {
    await rollbackCreatedStoryWorkspace({
      repositoryId: params.repositoryId,
      storyId: params.storyId,
      repositoryLocalPath: clonedRepository.localPath,
      createdWorktree,
      removeStoryWorktree: params.removeStoryWorktree,
      deleteStoryWorktreeBranch: params.deleteStoryWorktreeBranch,
      originalError: error,
    });

    if (isStoryWorkspaceUniqueConstraintError(error)) {
      const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(params.db, params.storyId);
      if (existingWorkspace) {
        assertStoryWorkspaceDoesNotExistForCreate({
          storyId: params.storyId,
          workspace: existingWorkspace,
          cause: error,
        });
      }
    }

    throw new DashboardIntegrationError(
      'internal_error',
      `Unable to persist story workspace for story id=${params.storyId}.`,
      {
        status: 500,
        details: {
          repositoryId: params.repositoryId,
          storyId: params.storyId,
          branch: createdWorktree.branch,
          worktreePath: createdWorktree.path,
        },
        cause: error,
      },
    );
  }
}

async function reconcileRemovedWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    occurredAt: string;
  },
): Promise<StoryWorkspaceRecord> {
  const workspacePathExists = await params.pathExists(params.workspace.worktreePath);
  if (workspacePathExists) {
    return markWorkspaceRemovedStateDrift(db, params.workspace, params.occurredAt);
  }

  if (params.repositoryLocalPath !== null && (await params.pathExists(params.repositoryLocalPath))) {
    try {
      const registered = (await params.listRepositoryWorktrees(params.repositoryLocalPath)).some(
        entry => normalizeFsPath(entry.path) === normalizeFsPath(params.workspace.worktreePath),
      );

      if (registered) {
        return markWorkspaceRemovedStateDrift(db, params.workspace, params.occurredAt);
      }
    } catch {
      // A git inspection failure does not prove removed-state drift when the path is already absent.
    }
  }

  return updateStoryWorkspace(db, {
    storyWorkspaceId: params.workspace.id,
    status: 'removed',
    statusReason: params.workspace.statusReason,
    lastReconciledAt: params.occurredAt,
    removedAt: params.workspace.removedAt ?? params.occurredAt,
    occurredAt: params.occurredAt,
  });
}

async function reconcileWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    occurredAt: string;
  },
): Promise<StoryWorkspaceRecord> {
  if (params.workspace.status === 'removed') {
    return reconcileRemovedWorkspaceRecord(db, params);
  }

  if (params.repositoryLocalPath === null || !(await params.pathExists(params.repositoryLocalPath))) {
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
  const workspacePathExists = await params.pathExists(params.workspace.worktreePath);

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

    if (!workspacePathExists) {
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
    statusReason: workspacePathExists ? 'worktree_not_registered' : 'missing_path',
    lastReconciledAt: params.occurredAt,
    removedAt: null,
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
  const removeStoryWorktree = dependencies.removeWorktree ?? removeWorktree;
  const deleteStoryWorktreeBranch = dependencies.deleteBranch ?? deleteBranch;
  const listRepositoryWorktrees = dependencies.listWorktrees ?? listWorktrees;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
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
          pathExists,
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
        const story = requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        assertStoryWorkspaceCreatable({
          repositoryName: repository.name,
          repositoryArchivedAt: repository.archivedAt,
          storyId: story.id,
          storyStatus: story.status,
        });

        const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(db, story.id);
        if (existingWorkspace) {
          assertStoryWorkspaceDoesNotExistForCreate({
            storyId: story.id,
            workspace: existingWorkspace,
          });
        }

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
          removeStoryWorktree,
          deleteStoryWorktreeBranch,
          occurredAt: now(),
        });

        return {
          workspace: toStoryWorkspaceSnapshot(created),
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
          pathExists,
          occurredAt: now(),
        });

        return {
          workspace: toStoryWorkspaceSnapshot(reconciled),
        };
      });
    },
  };
}
