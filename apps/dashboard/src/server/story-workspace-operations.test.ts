import { describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, repositories, workItems, type AlphredDatabase } from '@alphred/db';
import { createStoryWorkspaceOperations, type StoryWorkspaceOperationsDependencies } from './story-workspace-operations';

function createMigratedDb(): AlphredDatabase {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedRepositoryAndStory(db: AlphredDatabase): { repositoryId: number; storyId: number } {
  const repository = db
    .insert(repositories)
    .values({
      name: 'demo-repo',
      provider: 'github',
      remoteUrl: 'https://github.com/octocat/demo-repo.git',
      remoteRef: 'octocat/demo-repo',
      defaultBranch: 'main',
      localPath: '/tmp/alphred/repos/github/octocat/demo-repo',
      cloneStatus: 'cloned',
    })
    .returning({ id: repositories.id })
    .get();

  const story = db
    .insert(workItems)
    .values({
      repositoryId: repository.id,
      type: 'story',
      status: 'Draft',
      title: 'Create story workspace',
      revision: 0,
    })
    .returning({ id: workItems.id })
    .get();

  return {
    repositoryId: repository.id,
    storyId: story.id,
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

describe('story workspace operations', () => {
  it('creates a story workspace and returns it via getStoryWorkspace', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    const ensureRepositoryCloneMock = vi.fn(async () => ({
      action: 'fetched' as const,
      repository: {
        id: seed.repositoryId,
        name: 'demo-repo',
        provider: 'github' as const,
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/alphred/repos/github/octocat/demo-repo',
        cloneStatus: 'cloned' as const,
        archivedAt: null,
      },
      sync: {
        mode: 'fetch' as const,
        strategy: null,
        branch: null,
        status: 'fetched' as const,
        conflictMessage: null,
      },
    }));
    const createWorktreeMock: NonNullable<StoryWorkspaceOperationsDependencies['createWorktree']> = vi.fn(
      async (_repoDir, _worktreeBase, branchOrParams) => ({
        path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
        branch: typeof branchOrParams === 'string' ? branchOrParams : (branchOrParams.branch ?? 'alphred/story/1-a1b2c3'),
        commit: 'abc123',
      }),
    );

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: ensureRepositoryCloneMock,
        createWorktree: createWorktreeMock,
      },
      environment: createTestEnvironment(),
    });

    const created = await operations.createStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(created.created).toBe(true);
    expect(created.workspace.repositoryId).toBe(seed.repositoryId);
    expect(created.workspace.storyId).toBe(seed.storyId);
    expect(created.workspace.baseBranch).toBe('main');
    expect(created.workspace.path).toBe('/tmp/alphred/worktrees/alphred-story-1-a1b2c3');
    expect(created.workspace.branch.startsWith(`alphred/story/${String(seed.storyId)}-`)).toBe(true);

    expect(ensureRepositoryCloneMock).toHaveBeenCalledTimes(1);
    expect(createWorktreeMock).toHaveBeenCalledTimes(1);

    const loaded = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(loaded).toEqual({
      workspace: created.workspace,
    });
  });

  it('returns an existing workspace idempotently without creating a second worktree', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    const ensureRepositoryCloneMock = vi.fn(async () => ({
      action: 'fetched' as const,
      repository: {
        id: seed.repositoryId,
        name: 'demo-repo',
        provider: 'github' as const,
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/alphred/repos/github/octocat/demo-repo',
        cloneStatus: 'cloned' as const,
        archivedAt: null,
      },
      sync: {
        mode: 'fetch' as const,
        strategy: null,
        branch: null,
        status: 'fetched' as const,
        conflictMessage: null,
      },
    }));
    const createWorktreeMock: NonNullable<StoryWorkspaceOperationsDependencies['createWorktree']> = vi.fn(async () => ({
      path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      commit: 'abc123',
    }));

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: ensureRepositoryCloneMock,
        createWorktree: createWorktreeMock,
      },
      environment: createTestEnvironment(),
    });

    const first = await operations.createStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });
    const second = await operations.createStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspace).toEqual(first.workspace);
    expect(createWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-story work items', async () => {
    const db = createMigratedDb();

    const repository = db
      .insert(repositories)
      .values({
        name: 'demo-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
      })
      .returning({ id: repositories.id })
      .get();

    const task = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task not story',
        revision: 0,
      })
      .returning({ id: workItems.id })
      .get();

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: vi.fn(),
        createWorktree: vi.fn(),
      },
      environment: createTestEnvironment(),
    });

    await expect(
      operations.createStoryWorkspace({
        repositoryId: repository.id,
        storyId: task.id,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: `Work item id=${String(task.id)} is not a story.`,
    });
  });
});
