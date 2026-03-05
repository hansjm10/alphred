import { join } from 'node:path';
import {
  and,
  eq,
  getRepositoryById,
  getStoryWorkspaceByStoryWorkItemId,
  insertStoryWorkspace,
  workItems,
  type AlphredDatabase,
  type StoryWorkspaceRecord,
} from '@alphred/db';
import {
  createWorktree,
  ensureRepositoryClone,
  generateConfiguredBranchName,
  resolveSandboxDir,
} from '@alphred/git';
import type {
  DashboardCreateStoryWorkspaceRequest,
  DashboardCreateStoryWorkspaceResult,
  DashboardGetStoryWorkspaceRequest,
  DashboardGetStoryWorkspaceResult,
  DashboardStoryWorkspaceSnapshot,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

export type StoryWorkspaceOperationsDependencies = {
  ensureRepositoryClone: typeof ensureRepositoryClone;
  createWorktree?: typeof createWorktree;
};

export type StoryWorkspaceOperations = {
  getStoryWorkspace: (request: DashboardGetStoryWorkspaceRequest) => Promise<DashboardGetStoryWorkspaceResult>;
  createStoryWorkspace: (request: DashboardCreateStoryWorkspaceRequest) => Promise<DashboardCreateStoryWorkspaceResult>;
};

const STORY_WORKSPACE_TREE_KEY = 'story-workspace';
const STORY_WORKSPACE_BRANCH_TEMPLATE = 'alphred/story/{run-id}-{short-hash}';

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DashboardIntegrationError('invalid_request', `${label} must be a positive integer.`, {
      status: 400,
    });
  }

  return value;
}

function toStoryWorkspaceSnapshot(record: StoryWorkspaceRecord): DashboardStoryWorkspaceSnapshot {
  return {
    id: record.id,
    repositoryId: record.repositoryId,
    storyId: record.storyWorkItemId,
    path: record.worktreePath,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommitHash: record.baseCommitHash,
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
): { id: number; repositoryId: number } {
  const row = db
    .select({
      id: workItems.id,
      repositoryId: workItems.repositoryId,
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
  };
}

export function createStoryWorkspaceOperations(params: {
  withDatabase: WithDatabase;
  dependencies: StoryWorkspaceOperationsDependencies;
  environment: NodeJS.ProcessEnv;
}): StoryWorkspaceOperations {
  const { withDatabase, dependencies, environment } = params;
  const createStoryWorktree = dependencies.createWorktree ?? createWorktree;
  const worktreeBase = join(resolveSandboxDir(environment), 'worktrees');

  return {
    getStoryWorkspace(requestRaw): Promise<DashboardGetStoryWorkspaceResult> {
      const repositoryId = requirePositiveInteger(requestRaw.repositoryId, 'repositoryId');
      const storyId = requirePositiveInteger(requestRaw.storyId, 'storyId');

      return withDatabase(db => {
        requireStoryWorkItem(db, {
          repositoryId,
          storyId,
        });

        const workspace = getStoryWorkspaceByStoryWorkItemId(db, storyId);
        return {
          workspace: workspace ? toStoryWorkspaceSnapshot(workspace) : null,
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

        const existingWorkspace = getStoryWorkspaceByStoryWorkItemId(db, story.id);
        if (existingWorkspace) {
          return {
            workspace: toStoryWorkspaceSnapshot(existingWorkspace),
            created: false,
          };
        }

        const repository = getRepositoryById(db, repositoryId, { includeArchived: true });
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
            status: 404,
          });
        }
        if (repository.archivedAt !== null) {
          throw new DashboardIntegrationError(
            'conflict',
            `Repository "${repository.name}" is archived. Restore it before creating a story workspace.`,
            {
              status: 409,
              details: {
                repositoryId,
                archivedAt: repository.archivedAt,
              },
            },
          );
        }

        const ensured = await dependencies.ensureRepositoryClone({
          db,
          repository: {
            name: repository.name,
            provider: repository.provider,
            remoteUrl: repository.remoteUrl,
            remoteRef: repository.remoteRef,
            defaultBranch: repository.defaultBranch,
          },
          environment,
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
            runId: story.id,
          },
          STORY_WORKSPACE_BRANCH_TEMPLATE,
        );

        let createdWorktree: Awaited<ReturnType<typeof createWorktree>>;
        try {
          createdWorktree = await createStoryWorktree(clonedRepository.localPath, worktreeBase, {
            branch,
            baseRef: baseBranch,
          });
        } catch (error) {
          throw new DashboardIntegrationError(
            'conflict',
            `Unable to create story workspace for story id=${story.id}.`,
            {
              status: 409,
              details: {
                repositoryId: clonedRepository.id,
                storyId: story.id,
                branch,
              },
              cause: error,
            },
          );
        }

        const createdWorkspace = insertStoryWorkspace(db, {
          repositoryId: clonedRepository.id,
          storyWorkItemId: story.id,
          worktreePath: createdWorktree.path,
          branch: createdWorktree.branch,
          baseBranch,
          baseCommitHash: createdWorktree.commit,
        });

        return {
          workspace: toStoryWorkspaceSnapshot(createdWorkspace),
          created: true,
        };
      });
    },
  };
}
