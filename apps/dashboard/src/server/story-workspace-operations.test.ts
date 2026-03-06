import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  getStoryWorkspaceByStoryWorkItemId,
  insertStoryWorkspace,
  migrateDatabase,
  repositories,
  type AlphredDatabase,
  workItems,
} from '@alphred/db';
import type { RepositoryConfig } from '@alphred/shared';
import { createStoryWorkspaceOperations, type StoryWorkspaceOperationsDependencies } from './story-workspace-operations';

function createMigratedDb(): AlphredDatabase {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedRepositoryAndStory(
  db: AlphredDatabase,
  overrides: {
    archivedAt?: string | null;
    storyStatus?: 'Draft' | 'Approved' | 'Done';
  } = {},
): { repositoryId: number; storyId: number; repository: RepositoryConfig } {
  const repository = db
    .insert(repositories)
    .values({
      name: 'demo-repo',
      provider: 'github',
      remoteUrl: 'https://github.com/octocat/demo-repo.git',
      remoteRef: 'octocat/demo-repo',
      defaultBranch: 'main',
      branchTemplate: null,
      localPath: '/tmp/alphred/repos/github/octocat/demo-repo',
      cloneStatus: 'cloned',
      archivedAt: overrides.archivedAt ?? null,
    })
    .returning()
    .get() as RepositoryConfig;

  const story = db
    .insert(workItems)
    .values({
      repositoryId: repository.id,
      type: 'story',
      status: overrides.storyStatus ?? 'Draft',
      title: 'Create story workspace',
      revision: 0,
    })
    .returning({ id: workItems.id })
    .get();

  return {
    repositoryId: repository.id,
    storyId: story.id,
    repository,
  };
}

function createWithDatabase(db: AlphredDatabase) {
  return async <T>(operation: (database: AlphredDatabase) => Promise<T> | T): Promise<T> => operation(db);
}

function createTestEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALPHRED_SANDBOX_DIR: '/tmp/alphred',
  };
}

function createDependencies(
  repository: RepositoryConfig,
  overrides: Partial<StoryWorkspaceOperationsDependencies> = {},
): StoryWorkspaceOperationsDependencies {
  return {
    ensureRepositoryClone: async () => ({
      action: 'fetched' as const,
      repository,
      sync: {
        mode: 'fetch' as const,
        strategy: null,
        branch: null,
        status: 'fetched' as const,
        conflictMessage: null,
      },
    }),
    createWorktree: async (_repoDir, _worktreeBase, params) => ({
      path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: typeof params === 'string' ? params : (params.branch ?? 'alphred/story/1-a1b2c3'),
      commit: 'abc123',
    }),
    listWorktrees: async () => [
      {
        path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
        branch: 'alphred/story/1-a1b2c3',
        commit: 'abc123',
      },
    ],
    removeWorktree: async () => undefined,
    deleteBranch: async () => undefined,
    pathExists: async () => true,
    removePath: async () => undefined,
    now: () => '2026-03-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('story workspace operations', () => {
  it('creates a story workspace and returns it via getStoryWorkspace', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);
    const listWorktreesMock = vi
      .fn<NonNullable<StoryWorkspaceOperationsDependencies['listWorktrees']>>()
      .mockResolvedValue([]);

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: listWorktreesMock,
      }),
      environment: createTestEnvironment(),
    });

    const created = await operations.createStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(created.created).toBe(true);
    expect(created.workspace.repositoryId).toBe(seed.repositoryId);
    expect(created.workspace.storyId).toBe(seed.storyId);
    expect(created.workspace.status).toBe('active');
    expect(created.workspace.statusReason).toBeNull();
    expect(created.workspace.branch.startsWith(`alphred/story/${String(seed.storyId)}-`)).toBe(true);

    listWorktreesMock.mockResolvedValueOnce([
      {
        path: created.workspace.path,
        branch: created.workspace.branch,
        commit: created.workspace.baseCommitHash ?? 'abc123',
      },
    ]);

    const loaded = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(loaded).toEqual({
      workspace: created.workspace,
    });
  });

  it('reconciles an existing workspace to stale when the path is missing', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        pathExists: async () => false,
        now: () => '2026-03-06T01:00:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const loaded = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(loaded.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-06T01:00:00.000Z',
    });
  });

  it('reconciles a workspace to stale when git no longer registers the worktree path', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [],
        pathExists: async () => true,
        now: () => '2026-03-06T01:02:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'worktree_not_registered',
      lastReconciledAt: '2026-03-06T01:02:00.000Z',
    });
  });

  it('reconciles a workspace to stale when the registered branch no longer matches', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [
          {
            path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
            branch: 'alphred/story/1-z9y8x7',
            commit: 'abc123',
          },
        ],
        now: () => '2026-03-06T01:05:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'branch_mismatch',
      lastReconciledAt: '2026-03-06T01:05:00.000Z',
    });
  });

  it('cleans up a story workspace and marks it removed', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const removeWorktreeMock = vi.fn(async () => {
      worktreeRegistered = false;
    });
    const deleteBranchMock = vi.fn(async () => undefined);

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () =>
          worktreeRegistered
            ? [
                {
                  path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        removeWorktree: removeWorktreeMock,
        pathExists: async () => workspacePathExists,
        removePath: async () => {
          workspacePathExists = false;
        },
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:10:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(
      seed.repository.localPath,
      '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
    );
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, 'alphred/story/1-a1b2c3');
    expect(cleaned.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:10:00.000Z',
    });
  });

  it('rejects cleanup when git still reports the worktree after removal fails', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    let workspacePathExists = true;
    const deleteBranchMock = vi.fn(async () => undefined);

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [
          {
            path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
            branch: 'alphred/story/1-a1b2c3',
            commit: 'abc123',
          },
        ],
        removeWorktree: async () => {
          throw new Error('git remove failed');
        },
        pathExists: async () => workspacePathExists,
        removePath: async () => {
          workspacePathExists = false;
        },
        deleteBranch: deleteBranchMock,
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.cleanupStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Unable to clean up story workspace for story id=${seed.storyId}.`,
    });

    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'active',
      removedAt: null,
    });
  });

  it('retires a workspace when git removal errors but verification shows it is already gone', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    let workspacePathExists = true;
    let listCalls = 0;

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => {
          listCalls += 1;
          return listCalls === 1
            ? [
                {
                  path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [];
        },
        removeWorktree: async () => {
          throw new Error('git remove reported failure');
        },
        pathExists: async () => workspacePathExists,
        removePath: async () => {
          workspacePathExists = false;
        },
        now: () => '2026-03-06T01:12:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(cleaned.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:12:00.000Z',
    });
  });

  it('rejects cleanup when the workspace path remains after git cleanup succeeds', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    let worktreeRegistered = true;

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () =>
          worktreeRegistered
            ? [
                {
                  path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        removeWorktree: async () => {
          worktreeRegistered = false;
        },
        pathExists: async () => true,
        removePath: async () => {
          throw new Error('rm failed');
        },
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.cleanupStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });

    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'active',
      removedAt: null,
    });
  });

  it('recreates a removed workspace in place on the same row', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () =>
          worktreeRegistered
            ? [
                {
                  path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        removeWorktree: async () => {
          worktreeRegistered = false;
        },
        pathExists: async () => workspacePathExists,
        removePath: async () => {
          workspacePathExists = false;
        },
        createWorktree: async () => ({
          path: '/tmp/alphred/worktrees/alphred-story-1-d4e5f6',
          branch: 'alphred/story/1-d4e5f6',
          commit: 'def456',
        }),
        now: () => '2026-03-06T01:20:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const recreated = await operations.recreateStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(recreated.workspace).toMatchObject({
      id: existing.id,
      path: '/tmp/alphred/worktrees/alphred-story-1-d4e5f6',
      branch: 'alphred/story/1-d4e5f6',
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      removedAt: null,
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)?.id).toBe(existing.id);
  });

  it('rejects create and recreate requests when the repository is archived or the story is done', async () => {
    const archivedDb = createMigratedDb();
    const archivedSeed = seedRepositoryAndStory(archivedDb, { archivedAt: '2026-03-06T00:00:00.000Z' });

    const archivedOperations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(archivedDb),
      dependencies: createDependencies(archivedSeed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      archivedOperations.createStoryWorkspace({
        repositoryId: archivedSeed.repositoryId,
        storyId: archivedSeed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });

    const doneDb = createMigratedDb();
    const doneSeed = seedRepositoryAndStory(doneDb, { storyStatus: 'Done' });
    insertStoryWorkspace(doneDb, {
      repositoryId: doneSeed.repositoryId,
      storyWorkItemId: doneSeed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
    });

    const doneOperations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(doneDb),
      dependencies: createDependencies(doneSeed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      doneOperations.recreateStoryWorkspace({
        repositoryId: doneSeed.repositoryId,
        storyId: doneSeed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });
});
