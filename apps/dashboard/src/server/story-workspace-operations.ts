import { constants } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  and,
  eq,
  getRepositoryById,
  getStoryWorkspaceById,
  getStoryWorkspaceByStoryWorkItemId,
  insertStoryWorkspace,
  reactivateRemovedStoryWorkspace,
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
  type WorktreeInfo,
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
  removePath?: (path: string) => Promise<void>;
  now?: () => string;
};

export type StoryWorkspaceOperations = {
  getStoryWorkspace: (request: DashboardGetStoryWorkspaceRequest) => Promise<DashboardGetStoryWorkspaceResult>;
  createStoryWorkspace: (request: DashboardCreateStoryWorkspaceRequest) => Promise<DashboardCreateStoryWorkspaceResult>;
  cleanupStoryWorkspace: (
    request: DashboardCleanupStoryWorkspaceRequest,
  ) => Promise<DashboardCleanupStoryWorkspaceResult>;
  reconcileStoryWorkspace: (
    request: DashboardReconcileStoryWorkspaceRequest,
  ) => Promise<DashboardReconcileStoryWorkspaceResult>;
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

function isDescendantPath(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(normalizeFsPath(rootPath), normalizeFsPath(candidatePath));
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath);
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

function assertStoryWorkspaceRecreatable(params: {
  repositoryName: string;
  repositoryArchivedAt: string | null;
  storyId: number;
  storyStatus: string;
}): void {
  if (params.repositoryArchivedAt !== null) {
    throw new DashboardIntegrationError(
      'conflict',
      `Repository "${params.repositoryName}" is archived. Restore it before recreating a story workspace.`,
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
      `Story id=${params.storyId} is already ${params.storyStatus}. Story workspaces cannot be recreated for done stories.`,
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

function isStoryWorkspaceReactivationPreconditionError(error: unknown): boolean {
  return readErrorMessage(error)
    .toLowerCase()
    .includes('story workspace reactivation precondition failed');
}

function isStoryWorkspaceUpdatePreconditionError(error: unknown): boolean {
  return readErrorMessage(error)
    .toLowerCase()
    .includes('story workspace update precondition failed');
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

async function defaultRemovePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

type RegisteredWorktreeInspection =
  | {
      state: 'registered';
      worktree: WorktreeInfo;
    }
  | {
      state: 'unregistered' | 'unknown';
      worktree: null;
    };

function toCleanupConflict(params: {
  storyWorkspaceId: number;
  storyId: number;
  worktreePath: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}): DashboardIntegrationError {
  return new DashboardIntegrationError('conflict', `Unable to clean up story workspace for story id=${params.storyId}.`, {
    status: 409,
    details: {
      storyWorkspaceId: params.storyWorkspaceId,
      storyId: params.storyId,
      worktreePath: params.worktreePath,
      ...(params.details ?? {}),
    },
    cause: params.cause,
  });
}

function toUnmanagedWorkspacePathConflict(params: {
  storyWorkspaceId: number;
  storyId: number;
  worktreePath: string;
  managedWorktreeRoot: string;
}): DashboardIntegrationError {
  return new DashboardIntegrationError(
    'conflict',
    `Story workspace for story id=${params.storyId} points outside the managed worktree root and cannot be modified safely.`,
    {
      status: 409,
      details: {
        storyWorkspaceId: params.storyWorkspaceId,
        storyId: params.storyId,
        worktreePath: params.worktreePath,
        managedWorktreeRoot: params.managedWorktreeRoot,
        reason: 'unmanaged_worktree_path',
      },
    },
  );
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

function assertManagedWorktreePath(params: {
  storyWorkspaceId: number;
  storyId: number;
  worktreePath: string;
  managedWorktreeRoot: string;
}): void {
  if (isDescendantPath(params.managedWorktreeRoot, params.worktreePath)) {
    return;
  }

  throw toUnmanagedWorkspacePathConflict(params);
}

function isUnmanagedWorkspacePathConflict(error: unknown): boolean {
  return (
    error instanceof DashboardIntegrationError &&
    typeof error.details?.reason === 'string' &&
    error.details.reason === 'unmanaged_worktree_path'
  );
}

function markWorkspaceRemovedStateDrift(
  db: AlphredDatabase,
  workspace: StoryWorkspaceRecord,
  occurredAt: string,
): StoryWorkspaceRecord {
  try {
    return updateStoryWorkspace(db, {
      storyWorkspaceId: workspace.id,
      expectedStatus: 'removed',
      status: 'stale',
      statusReason: 'removed_state_drift',
      lastReconciledAt: occurredAt,
      removedAt: null,
      occurredAt,
    });
  } catch (error) {
    if (!isStoryWorkspaceUpdatePreconditionError(error)) {
      throw error;
    }

    const currentWorkspace = getStoryWorkspaceById(db, workspace.id);
    if (currentWorkspace) {
      return currentWorkspace;
    }

    throw error;
  }
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
  existingWorkspace?: StoryWorkspaceRecord | null;
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
    if (params.existingWorkspace) {
      return reactivateRemovedStoryWorkspace(params.db, {
        storyWorkspaceId: params.existingWorkspace.id,
        worktreePath: createdWorktree.path,
        branch: createdWorktree.branch,
        baseBranch,
        baseCommitHash: createdWorktree.commit,
        lastReconciledAt: params.occurredAt,
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

    if (!params.existingWorkspace && isStoryWorkspaceUniqueConstraintError(error)) {
      const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(params.db, params.storyId);
      if (existingWorkspace) {
        assertStoryWorkspaceDoesNotExistForCreate({
          storyId: params.storyId,
          workspace: existingWorkspace,
          cause: error,
        });
      }
    }

    if (params.existingWorkspace && isStoryWorkspaceReactivationPreconditionError(error)) {
      const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(params.db, params.storyId);
      if (existingWorkspace) {
        throw toRecreateConflict(existingWorkspace);
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

async function inspectRegisteredWorktreeState(params: {
  repositoryLocalPath: string | null;
  workspacePath: string;
  listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
  pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
}): Promise<RegisteredWorktreeInspection> {
  if (params.repositoryLocalPath === null) {
    return {
      state: 'unregistered',
      worktree: null,
    };
  }

  if (!(await params.pathExists(params.repositoryLocalPath))) {
    return {
      state: 'unregistered',
      worktree: null,
    };
  }

  try {
    const worktrees = await params.listRepositoryWorktrees(params.repositoryLocalPath);
    const matchingWorktree =
      worktrees.find(entry => normalizeFsPath(entry.path) === normalizeFsPath(params.workspacePath)) ?? null;

    if (matchingWorktree) {
      return {
        state: 'registered',
        worktree: matchingWorktree,
      };
    }

    return {
      state: 'unregistered',
      worktree: null,
    };
  } catch {
    return {
      state: 'unknown',
      worktree: null,
    };
  }
}

async function cleanupWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    managedWorktreeRoot: string;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    removeStoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
    deleteStoryWorktreeBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    removePath: NonNullable<StoryWorkspaceOperationsDependencies['removePath']>;
    occurredAt: string;
    removedAtOnSuccess?: string | null;
  },
): Promise<StoryWorkspaceRecord> {
  assertManagedWorktreePath({
    storyWorkspaceId: params.workspace.id,
    storyId: params.workspace.storyWorkItemId,
    worktreePath: params.workspace.worktreePath,
    managedWorktreeRoot: params.managedWorktreeRoot,
  });

  const registeredInspectionBeforeRemoval = await inspectRegisteredWorktreeState({
    repositoryLocalPath: params.repositoryLocalPath,
    workspacePath: params.workspace.worktreePath,
    listRepositoryWorktrees: params.listRepositoryWorktrees,
    pathExists: params.pathExists,
  });
  const registeredStateBeforeRemoval = registeredInspectionBeforeRemoval.state;
  const workspacePathExistsBeforeRemoval = await params.pathExists(params.workspace.worktreePath);

  if (
    registeredInspectionBeforeRemoval.state === 'registered' &&
    registeredInspectionBeforeRemoval.worktree.branch !== params.workspace.branch
  ) {
    if (params.workspace.status !== 'removed') {
      updateStoryWorkspace(db, {
        storyWorkspaceId: params.workspace.id,
        status: 'stale',
        statusReason: 'branch_mismatch',
        lastReconciledAt: params.occurredAt,
        removedAt: null,
        occurredAt: params.occurredAt,
      });
    }

    throw toCleanupConflict({
      storyWorkspaceId: params.workspace.id,
      storyId: params.workspace.storyWorkItemId,
      worktreePath: params.workspace.worktreePath,
      details: {
        reason: 'branch_mismatch',
        expectedBranch: params.workspace.branch,
        registeredBranch: registeredInspectionBeforeRemoval.worktree.branch,
      },
    });
  }

  let cleanupError: unknown = null;

  if (params.repositoryLocalPath !== null && registeredStateBeforeRemoval !== 'unregistered') {
    try {
      await params.removeStoryWorktree(params.repositoryLocalPath, params.workspace.worktreePath);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (workspacePathExistsBeforeRemoval) {
    try {
      await params.removePath(params.workspace.worktreePath);
    } catch (error) {
      if (cleanupError === null) {
        cleanupError = error;
      }
    }
  }

  const registeredInspectionAfterRemoval =
    registeredStateBeforeRemoval === 'unregistered'
      ? {
          state: 'unregistered' as const,
          worktree: null,
        }
      : await inspectRegisteredWorktreeState({
          repositoryLocalPath: params.repositoryLocalPath,
          workspacePath: params.workspace.worktreePath,
          listRepositoryWorktrees: params.listRepositoryWorktrees,
          pathExists: params.pathExists,
        });
  const workspacePathExistsAfterRemoval = await params.pathExists(params.workspace.worktreePath);

  if (
    workspacePathExistsAfterRemoval ||
    registeredInspectionAfterRemoval.state === 'registered' ||
    registeredInspectionAfterRemoval.state === 'unknown'
  ) {
    throw toCleanupConflict({
      storyWorkspaceId: params.workspace.id,
      storyId: params.workspace.storyWorkItemId,
      worktreePath: params.workspace.worktreePath,
      cause: cleanupError,
    });
  }

  if (params.repositoryLocalPath !== null) {
    try {
      await params.deleteStoryWorktreeBranch(params.repositoryLocalPath, params.workspace.branch);
    } catch {
      // Branch deletion is best-effort once the workspace itself is gone.
    }
  }

  try {
    return updateStoryWorkspace(db, {
      storyWorkspaceId: params.workspace.id,
      expectedStatus: params.workspace.status === 'removed' ? 'removed' : undefined,
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: params.occurredAt,
      removedAt: params.removedAtOnSuccess ?? params.occurredAt,
      occurredAt: params.occurredAt,
    });
  } catch (error) {
    if (!isStoryWorkspaceUpdatePreconditionError(error)) {
      throw error;
    }

    const currentWorkspace = getStoryWorkspaceById(db, params.workspace.id);
    if (currentWorkspace) {
      return currentWorkspace;
    }

    throw error;
  }
}

async function repairRemovedWorkspaceRecord(
  db: AlphredDatabase,
  params: {
    repositoryLocalPath: string | null;
    workspace: StoryWorkspaceRecord;
    managedWorktreeRoot: string;
    listRepositoryWorktrees: NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>;
    removeStoryWorktree: NonNullable<StoryWorkspaceOperationsDependencies['removeWorktree']>;
    deleteStoryWorktreeBranch: NonNullable<StoryWorkspaceOperationsDependencies['deleteBranch']>;
    pathExists: NonNullable<StoryWorkspaceOperationsDependencies['pathExists']>;
    removePath: NonNullable<StoryWorkspaceOperationsDependencies['removePath']>;
    occurredAt: string;
  },
): Promise<StoryWorkspaceRecord> {
  try {
    return await cleanupWorkspaceRecord(db, {
      ...params,
      removedAtOnSuccess: params.workspace.removedAt ?? params.occurredAt,
    });
  } catch (error) {
    if (!(error instanceof DashboardIntegrationError)) {
      throw error;
    }
    if (isUnmanagedWorkspacePathConflict(error)) {
      throw error;
    }
    return markWorkspaceRemovedStateDrift(db, params.workspace, params.occurredAt);
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

    cleanupStoryWorkspace(requestRaw): Promise<DashboardCleanupStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        const workspace = requireStoryWorkspace(db, storyId);
        const occurredAt = now();
        const cleaned = await cleanupWorkspaceRecord(db, {
          repositoryLocalPath: repository.localPath,
          workspace,
          managedWorktreeRoot: worktreeBase,
          listRepositoryWorktrees,
          removeStoryWorktree,
          deleteStoryWorktreeBranch,
          pathExists,
          removePath,
          occurredAt,
          removedAtOnSuccess: workspace.removedAt ?? occurredAt,
        });
        if (cleaned.status !== 'removed') {
          throw toCleanupConflict({
            storyWorkspaceId: cleaned.id,
            storyId: cleaned.storyWorkItemId,
            worktreePath: cleaned.worktreePath,
            details: {
              currentStatus: cleaned.status,
              expectedStatus: workspace.status,
              reason: 'workspace_state_changed',
            },
          });
        }

        return {
          workspace: toStoryWorkspaceSnapshot(cleaned),
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

    recreateStoryWorkspace(requestRaw): Promise<DashboardRecreateStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(async db => {
        const story = requireStoryWorkItem(db, { repositoryId, storyId });
        const repository = requireRepository(db, repositoryId);
        assertStoryWorkspaceRecreatable({
          repositoryName: repository.name,
          repositoryArchivedAt: repository.archivedAt,
          storyId: story.id,
          storyStatus: story.status,
        });

        const existingWorkspace = requireStoryWorkspace(db, story.id);
        const occurredAt = now();
        const recreatableWorkspace =
          existingWorkspace.status === 'removed'
            ? await repairRemovedWorkspaceRecord(db, {
                repositoryLocalPath: repository.localPath,
                workspace: existingWorkspace,
                managedWorktreeRoot: worktreeBase,
                listRepositoryWorktrees,
                removeStoryWorktree,
                deleteStoryWorktreeBranch,
                pathExists,
                removePath,
                occurredAt,
              })
            : await reconcileWorkspaceRecord(db, {
                repositoryLocalPath: repository.localPath,
                workspace: existingWorkspace,
                listRepositoryWorktrees,
                pathExists,
                occurredAt,
              });

        if (recreatableWorkspace.status !== 'removed') {
          throw toRecreateConflict(recreatableWorkspace);
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
          removeStoryWorktree,
          deleteStoryWorktreeBranch,
          existingWorkspace: recreatableWorkspace,
          occurredAt,
        });

        return {
          workspace: toStoryWorkspaceSnapshot(recreated),
        };
      });
    },
  };
}
