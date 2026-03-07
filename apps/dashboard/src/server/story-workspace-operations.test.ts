import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  getStoryWorkspaceByStoryWorkItemId,
  insertStoryWorkspace,
  migrateDatabase,
  repositories,
  updateStoryWorkspace,
  type AlphredDatabase,
  workItems,
} from '@alphred/db';
import { createWorktree as createGitWorktree, type WorktreeInfo } from '@alphred/git';
import type { RepositoryConfig } from '@alphred/shared';
import { createStoryWorkspaceOperations, type StoryWorkspaceOperationsDependencies } from './story-workspace-operations';

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();
const GIT_ENV_KEYS = [
  'ALPHRED_SANDBOX_DIR',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'HOME',
  'XDG_CONFIG_HOME',
] as const;

function createMigratedDb(): AlphredDatabase {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedRepositoryAndStory(
  db: AlphredDatabase,
  overrides: {
    archivedAt?: string | null;
    defaultBranch?: string;
    storyStatus?: 'Draft' | 'Approved' | 'Done';
    localPath?: string | null;
  } = {},
): { repositoryId: number; storyId: number; repository: RepositoryConfig } {
  const repository = db
    .insert(repositories)
    .values({
      name: 'demo-repo',
      provider: 'github',
      remoteUrl: 'https://github.com/octocat/demo-repo.git',
      remoteRef: 'octocat/demo-repo',
      defaultBranch: overrides.defaultBranch ?? 'main',
      branchTemplate: null,
      localPath: overrides.localPath ?? '/tmp/alphred/repos/github/octocat/demo-repo',
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

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: environment,
  });

  return stdout.trim();
}

async function withGitEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const originalValues = new Map<(typeof GIT_ENV_KEYS)[number], string | undefined>();

  for (const key of GIT_ENV_KEYS) {
    originalValues.set(key, process.env[key]);
    const nextValue = environment[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    return await operation();
  } finally {
    for (const key of GIT_ENV_KEYS) {
      const originalValue = originalValues.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type LiveGitFixture = {
  sandboxDir: string;
  repositoryPath: string;
  initialCommit: string;
  gitEnvironment: NodeJS.ProcessEnv;
};

function requireLiveWorktree(worktree: WorktreeInfo | null): WorktreeInfo {
  if (worktree === null) {
    throw new Error('Expected the live createWorktree helper to create a worktree before the duplicate insert race.');
  }

  return worktree;
}

async function createLiveGitEnvironment(sandboxDir: string): Promise<NodeJS.ProcessEnv> {
  const emptyGlobalConfigPath = join(sandboxDir, 'empty.gitconfig');
  await writeFile(emptyGlobalConfigPath, '');

  return {
    ...process.env,
    ALPHRED_SANDBOX_DIR: sandboxDir,
    GIT_CONFIG_GLOBAL: emptyGlobalConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: sandboxDir,
    XDG_CONFIG_HOME: sandboxDir,
  };
}

async function createLiveGitFixture(): Promise<LiveGitFixture> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'alphred-story-workspace-'));
  cleanupPaths.add(sandboxDir);
  const gitEnvironment = await createLiveGitEnvironment(sandboxDir);

  const repositoryPath = join(sandboxDir, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(join(sandboxDir, 'worktrees'), { recursive: true });

  await runGit(repositoryPath, ['init'], gitEnvironment);
  await runGit(repositoryPath, ['config', 'user.email', 'alphred-tests@example.com'], gitEnvironment);
  await runGit(repositoryPath, ['config', 'user.name', 'Alphred Tests'], gitEnvironment);
  await runGit(repositoryPath, ['checkout', '-b', 'main'], gitEnvironment);
  await writeFile(join(repositoryPath, 'README.md'), '# fixture\n');
  await runGit(repositoryPath, ['add', 'README.md'], gitEnvironment);
  await runGit(repositoryPath, ['commit', '-m', 'initial'], gitEnvironment);

  return {
    sandboxDir,
    repositoryPath,
    initialCommit: await runGit(repositoryPath, ['rev-parse', 'HEAD'], gitEnvironment),
    gitEnvironment,
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
    removeWorktree: async () => undefined,
    deleteBranch: async () => undefined,
    listWorktrees: async () => [
      {
        path: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
        branch: 'alphred/story/1-a1b2c3',
        commit: 'abc123',
      },
    ],
    pathExists: async path =>
      path === repository.localPath || path === '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
    removePath: async () => undefined,
    now: () => '2026-03-06T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  for (const path of [...cleanupPaths]) {
    await rm(path, { recursive: true, force: true });
    cleanupPaths.delete(path);
  }
});

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

  it('creates a story workspace against a live git repository and persists git state', async () => {
    const fixture = await createLiveGitFixture();
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, {
      localPath: fixture.repositoryPath,
      storyStatus: 'Approved',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: async () => ({
          action: 'fetched' as const,
          repository: seed.repository,
          sync: {
            mode: 'fetch' as const,
            strategy: null,
            branch: seed.repository.defaultBranch,
            status: 'fetched' as const,
            conflictMessage: null,
          },
        }),
        now: () => '2026-03-06T02:00:00.000Z',
      },
      environment: fixture.gitEnvironment,
    });

    const created = await withGitEnvironment(fixture.gitEnvironment, async () =>
      operations.createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    );

    const worktreeList = await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'], fixture.gitEnvironment);
    const branchCommit = await runGit(
      fixture.repositoryPath,
      ['rev-parse', '--verify', `refs/heads/${created.workspace.branch}`],
      fixture.gitEnvironment,
    );
    const worktreeCommit = await runGit(created.workspace.path, ['rev-parse', 'HEAD'], fixture.gitEnvironment);

    expect(created.workspace).toMatchObject({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
      status: 'active',
      statusReason: null,
      baseBranch: 'main',
      baseCommitHash: fixture.initialCommit,
      createdAt: '2026-03-06T02:00:00.000Z',
      updatedAt: '2026-03-06T02:00:00.000Z',
    });
    expect(created.workspace.branch.startsWith(`alphred/story/${String(seed.storyId)}-`)).toBe(true);
    expect(created.workspace.path.startsWith(join(fixture.sandboxDir, 'worktrees'))).toBe(true);
    expect(await pathExists(created.workspace.path)).toBe(true);
    expect(branchCommit).toBe(fixture.initialCommit);
    expect(worktreeCommit).toBe(fixture.initialCommit);
    expect(worktreeList).toContain(`worktree ${created.workspace.path}`);
    expect(worktreeList).toContain(`branch refs/heads/${created.workspace.branch}`);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: created.workspace.path,
      branch: created.workspace.branch,
      baseCommitHash: fixture.initialCommit,
      status: 'active',
    });
  });

  it('surfaces live createWorktree failure distinctly before any rollback cleanup', async () => {
    const fixture = await createLiveGitFixture();
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, {
      defaultBranch: 'missing-base',
      localPath: fixture.repositoryPath,
      storyStatus: 'Approved',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: async () => ({
          action: 'fetched' as const,
          repository: seed.repository,
          sync: {
            mode: 'fetch' as const,
            strategy: null,
            branch: seed.repository.defaultBranch,
            status: 'fetched' as const,
            conflictMessage: null,
          },
        }),
        now: () => '2026-03-06T02:02:00.000Z',
      },
      environment: fixture.gitEnvironment,
    });

    const thrown = await withGitEnvironment(fixture.gitEnvironment, async () =>
      operations
        .createStoryWorkspace({
          repositoryId: seed.repositoryId,
          storyId: seed.storyId,
        })
        .catch(error => error),
    );

    expect(thrown).toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Unable to create story workspace for story id=${seed.storyId}.`,
      details: {
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
        branch: expect.stringMatching(new RegExp(`^alphred/story/${seed.storyId}-`)),
      },
    });
    expect(thrown.message).not.toBe(`Unable to roll back story workspace create failure for story id=${seed.storyId}.`);
    expect(await readdir(join(fixture.sandboxDir, 'worktrees'))).toEqual([]);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toBeNull();
  });

  it('returns null from getStoryWorkspace when no workspace exists yet', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.getStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).resolves.toEqual({
      workspace: null,
    });
  });

  it('advances only lastReconciledAt across repeated unchanged active reads', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });

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
        now: vi
          .fn<() => string>()
          .mockReturnValueOnce('2026-03-06T01:00:00.000Z')
          .mockReturnValueOnce('2026-03-06T01:05:00.000Z'),
      }),
      environment: createTestEnvironment(),
    });

    const firstRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });
    const secondRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(firstRead.workspace).toMatchObject({
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-06T01:00:00.000Z',
      updatedAt: '2026-03-05T10:00:00.000Z',
    });
    expect(secondRead.workspace).toMatchObject({
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-06T01:05:00.000Z',
      updatedAt: '2026-03-05T10:00:00.000Z',
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-06T01:05:00.000Z',
      updatedAt: '2026-03-05T10:00:00.000Z',
    });
  });

  it('reconciles a workspace to stale when the path is missing', async () => {
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
        pathExists: async path => path === seed.repository.localPath,
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

  it('advances updatedAt when getStoryWorkspace reads reconcile stale state back to active', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const stale = updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        now: () => '2026-03-06T01:03:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const loaded = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(stale).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(loaded.workspace).toMatchObject({
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-06T01:03:00.000Z',
      updatedAt: '2026-03-06T01:03:00.000Z',
    });
  });

  it('advances only lastReconciledAt across repeated unchanged stale reads', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const stale = updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        pathExists: async path => path === seed.repository.localPath,
        now: vi
          .fn<() => string>()
          .mockReturnValueOnce('2026-03-06T01:10:00.000Z')
          .mockReturnValueOnce('2026-03-06T01:15:00.000Z'),
      }),
      environment: createTestEnvironment(),
    });

    const firstRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });
    const secondRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(stale).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(firstRead.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-06T01:10:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(secondRead.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-06T01:15:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-06T01:15:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
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

  it('reconciles a workspace to stale when the repository clone is missing on disk', async () => {
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
        pathExists: async path => path === '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
        now: () => '2026-03-06T01:06:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'repository_clone_missing',
      lastReconciledAt: '2026-03-06T01:06:00.000Z',
    });
  });

  it('reconciles a workspace to stale when git inspection fails', async () => {
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
        listWorktrees: async () => {
          throw new Error('git worktree list failed');
        },
        now: () => '2026-03-06T01:07:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      status: 'stale',
      statusReason: 'reconcile_failed',
      lastReconciledAt: '2026-03-06T01:07:00.000Z',
    });
  });

  it('reports removed-state drift when a removed workspace still exists on disk', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:19:00.000Z',
      occurredAt: '2026-03-06T01:19:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        now: () => '2026-03-06T01:20:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      id: existing.id,
      status: 'stale',
      statusReason: 'removed_state_drift',
      lastReconciledAt: '2026-03-06T01:20:00.000Z',
      removedAt: null,
    });
  });

  it('preserves removed state when git inspection fails after the worktree path is gone', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:21:00.000Z',
      occurredAt: '2026-03-06T01:21:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => {
          throw new Error('git worktree list failed');
        },
        pathExists: async path => path === seed.repository.localPath,
        now: () => '2026-03-06T01:22:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const reconciled = await operations.reconcileStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(reconciled.workspace).toMatchObject({
      id: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-06T01:22:00.000Z',
      removedAt: '2026-03-06T01:21:00.000Z',
    });
  });

  it('advances only lastReconciledAt across repeated unchanged removed reads', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    const removed = updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [],
        pathExists: async path => path === seed.repository.localPath,
        now: vi
          .fn<() => string>()
          .mockReturnValueOnce('2026-03-06T01:25:00.000Z')
          .mockReturnValueOnce('2026-03-06T01:30:00.000Z'),
      }),
      environment: createTestEnvironment(),
    });

    const firstRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });
    const secondRead = await operations.getStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removed).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-05T10:05:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(firstRead.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-06T01:25:00.000Z',
      removedAt: '2026-03-05T10:05:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(secondRead.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-06T01:30:00.000Z',
      removedAt: '2026-03-05T10:05:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-06T01:30:00.000Z',
      removedAt: '2026-03-05T10:05:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
  });

  it('cleans up a story workspace and retires its existing row', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const removeWorktreeMock = vi.fn(async () => {
      worktreeRegistered = false;
    });
    const removePathMock = vi.fn(async () => {
      workspacePathExists = false;
    });
    const deleteBranchMock = vi.fn(async () => undefined);

    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
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
                  path: workspacePath,
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        pathExists: async path => path === seed.repository.localPath || (path === workspacePath && workspacePathExists),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:35:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(seed.repository.localPath, workspacePath);
    expect(removePathMock).toHaveBeenCalledWith(workspacePath);
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, 'alphred/story/1-a1b2c3');
    expect(cleaned.workspace).toMatchObject({
      id: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:35:00.000Z',
      lastReconciledAt: '2026-03-06T01:35:00.000Z',
    });
  });

  it('rejects cleanup when the registered worktree branch no longer matches the workspace row', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const removeWorktreeMock = vi.fn(async () => undefined);
    const removePathMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);

    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
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
            path: workspacePath,
            branch: 'alphred/story/1-z9y8x7',
            commit: 'abc123',
          },
        ],
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:35:15.000Z',
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
      details: {
        storyWorkspaceId: existing.id,
        storyId: seed.storyId,
        worktreePath: workspacePath,
        reason: 'branch_mismatch',
        expectedBranch: 'alphred/story/1-a1b2c3',
        registeredBranch: 'alphred/story/1-z9y8x7',
      },
    });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removePathMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      id: existing.id,
      status: 'stale',
      statusReason: 'branch_mismatch',
      lastReconciledAt: '2026-03-06T01:35:15.000Z',
      removedAt: null,
    });
  });

  it('keeps cleanup successful when branch deletion fails after the worktree is gone', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const removeWorktreeMock = vi.fn(async () => {
      worktreeRegistered = false;
    });
    const removePathMock = vi.fn(async () => {
      workspacePathExists = false;
    });
    const deleteBranchMock = vi.fn(async () => {
      throw new Error('branch delete failed');
    });

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
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
                  path: workspacePath,
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        pathExists: async path => path === seed.repository.localPath || (path === workspacePath && workspacePathExists),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:35:30.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, 'alphred/story/1-a1b2c3');
    expect(cleaned.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:35:30.000Z',
    });
  });

  it('treats cleanup as idempotent when a removed workspace is already gone locally', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    const removed = updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:36:00.000Z',
      occurredAt: '2026-03-06T01:36:00.000Z',
    });
    const removeWorktreeMock = vi.fn(async () => undefined);
    const removePathMock = vi.fn(async () => undefined);

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [],
        pathExists: async path => path === seed.repository.localPath,
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        now: () => '2026-03-06T01:40:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removePathMock).not.toHaveBeenCalled();
    expect(removed).toMatchObject({
      status: 'removed',
      removedAt: '2026-03-06T01:36:00.000Z',
      updatedAt: '2026-03-06T01:36:00.000Z',
    });
    expect(cleaned.workspace).toMatchObject({
      id: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:36:00.000Z',
      lastReconciledAt: '2026-03-06T01:40:00.000Z',
      updatedAt: '2026-03-06T01:36:00.000Z',
    });
  });

  it('repairs leaked local state during cleanup for an already removed workspace', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const removeWorktreeMock = vi.fn(async () => {
      worktreeRegistered = false;
    });
    const removePathMock = vi.fn(async () => {
      workspacePathExists = false;
    });
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:41:00.000Z',
      occurredAt: '2026-03-06T01:41:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () =>
          worktreeRegistered
            ? [
                {
                  path: workspacePath,
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        pathExists: async path => path === seed.repository.localPath || (path === workspacePath && workspacePathExists),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:42:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const cleaned = await operations.cleanupStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(seed.repository.localPath, workspacePath);
    expect(removePathMock).toHaveBeenCalledWith(workspacePath);
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, 'alphred/story/1-a1b2c3');
    expect(cleaned.workspace).toMatchObject({
      id: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:41:00.000Z',
      lastReconciledAt: '2026-03-06T01:42:00.000Z',
    });
  });

  it('returns conflict when cleanup cannot verify removed-state repair', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let workspacePathExists = true;
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:43:00.000Z',
      occurredAt: '2026-03-06T01:43:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [
          {
            path: workspacePath,
            branch: 'alphred/story/1-a1b2c3',
            commit: 'abc123',
          },
        ],
        removeWorktree: async () => undefined,
        pathExists: async path => path === seed.repository.localPath || (path === workspacePath && workspacePathExists),
        removePath: async () => {
          workspacePathExists = false;
        },
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:44:00.000Z',
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
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:43:00.000Z',
    });
  });

  it('returns conflict when cleanup loses a concurrent recreate race for a removed workspace', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const repositoryLocalPath = seed.repository.localPath ?? '/tmp/alphred/repos/github/octocat/demo-repo';
    const originalPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const recreatedPath = '/tmp/alphred/worktrees/alphred-story-1-d4e5f6';
    const originalBranch = 'alphred/story/1-a1b2c3';
    const recreatedBranch = 'alphred/story/1-d4e5f6';
    let registeredWorktrees: WorktreeInfo[] = [
      {
        path: originalPath,
        branch: originalBranch,
        commit: 'abc123',
      },
    ];
    const existingPaths = new Set([repositoryLocalPath, originalPath]);
    let recreateTriggered = false;
    let recreateResult:
      | {
          workspace: {
            path: string;
            branch: string;
            status: string;
          };
        }
      | null = null;
    const removeWorktreeMock = vi.fn(async (_repositoryPath: string, workspacePath: string) => {
      registeredWorktrees = registeredWorktrees.filter(entry => entry.path !== workspacePath);
    });
    const removePathMock = vi.fn(async (workspacePath: string) => {
      existingPaths.delete(workspacePath);
    });
    const deleteBranchMock = vi.fn(async () => {
      if (recreateTriggered) {
        return;
      }

      recreateTriggered = true;
      recreateResult = await operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      });
    });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: originalPath,
      branch: originalBranch,
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:45:00.000Z',
      occurredAt: '2026-03-06T01:45:00.000Z',
    });

    const nowValues = ['2026-03-06T01:46:00.000Z', '2026-03-06T01:47:00.000Z'];
    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => registeredWorktrees,
        pathExists: async path => existingPaths.has(path),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        createWorktree: async () => {
          registeredWorktrees = [
            ...registeredWorktrees,
            {
              path: recreatedPath,
              branch: recreatedBranch,
              commit: 'def456',
            },
          ];
          existingPaths.add(recreatedPath);

          return {
            path: recreatedPath,
            branch: recreatedBranch,
            commit: 'def456',
          };
        },
        now: () => nowValues.shift() ?? '2026-03-06T01:47:00.000Z',
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
      details: {
        currentStatus: 'active',
        expectedStatus: 'removed',
        reason: 'workspace_state_changed',
      },
    });

    expect(recreateTriggered).toBe(true);
    expect(removeWorktreeMock).toHaveBeenCalledWith(repositoryLocalPath, originalPath);
    expect(removePathMock).toHaveBeenCalledWith(originalPath);
    expect(recreateResult).toMatchObject({
      workspace: {
        path: recreatedPath,
        branch: recreatedBranch,
        status: 'active',
      },
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      id: existing.id,
      worktreePath: recreatedPath,
      branch: recreatedBranch,
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      removedAt: null,
      lastReconciledAt: '2026-03-06T01:47:00.000Z',
    });
  });

  it('rejects cleanup when the workspace path is outside the managed worktree root', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/elsewhere/alphred-story-1-a1b2c3';
    const listWorktreesMock = vi.fn(async () => []);
    const removeWorktreeMock = vi.fn(async () => undefined);
    const removePathMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: listWorktreesMock,
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
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
      message: `Story workspace for story id=${seed.storyId} points outside the managed worktree root and cannot be modified safely.`,
      details: {
        storyWorkspaceId: existing.id,
        storyId: seed.storyId,
        worktreePath: workspacePath,
        managedWorktreeRoot: '/tmp/alphred/worktrees',
        reason: 'unmanaged_worktree_path',
      },
    });

    expect(listWorktreesMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removePathMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'active',
      worktreePath: workspacePath,
    });
  });

  it('recreates a removed workspace in place after removed-state repair succeeds', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const originalPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let worktreeRegistered = true;
    let workspacePathExists = true;
    const removeWorktreeMock = vi.fn(async () => {
      worktreeRegistered = false;
    });
    const removePathMock = vi.fn(async () => {
      workspacePathExists = false;
    });
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: originalPath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:45:00.000Z',
      occurredAt: '2026-03-06T01:45:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () =>
          worktreeRegistered
            ? [
                {
                  path: originalPath,
                  branch: 'alphred/story/1-a1b2c3',
                  commit: 'abc123',
                },
              ]
            : [],
        pathExists: async path => path === seed.repository.localPath || (path === originalPath && workspacePathExists),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        createWorktree: async () => ({
          path: '/tmp/alphred/worktrees/alphred-story-1-d4e5f6',
          branch: 'alphred/story/1-d4e5f6',
          commit: 'def456',
        }),
        now: () => '2026-03-06T01:46:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    const recreated = await operations.recreateStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(seed.repository.localPath, originalPath);
    expect(removePathMock).toHaveBeenCalledWith(originalPath);
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, 'alphred/story/1-a1b2c3');
    expect(recreated.workspace).toMatchObject({
      id: existing.id,
      path: '/tmp/alphred/worktrees/alphred-story-1-d4e5f6',
      branch: 'alphred/story/1-d4e5f6',
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      removedAt: null,
      lastReconciledAt: '2026-03-06T01:46:00.000Z',
    });
  });

  it('rejects recreate when removed-state repair encounters a branch-mismatched worktree', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const originalPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const removeWorktreeMock = vi.fn(async () => undefined);
    const removePathMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);
    const createWorktreeMock = vi.fn(createDependencies(seed.repository).createWorktree);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: originalPath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:45:00.000Z',
      occurredAt: '2026-03-06T01:45:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [
          {
            path: originalPath,
            branch: 'alphred/story/1-z9y8x7',
            commit: 'abc123',
          },
        ],
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        createWorktree: createWorktreeMock,
        now: () => '2026-03-06T01:46:30.000Z',
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} must be removed before it can be recreated.`,
      details: {
        storyWorkspaceId: existing.id,
        storyId: seed.storyId,
        currentStatus: 'stale',
        allowedStatuses: ['removed'],
      },
    });

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removePathMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      id: existing.id,
      status: 'stale',
      statusReason: 'removed_state_drift',
      lastReconciledAt: '2026-03-06T01:46:30.000Z',
      removedAt: null,
    });
  });

  it('rolls back and reports conflict when recreate loses a duplicate-request race', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const originalPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const createdPath = '/tmp/alphred/worktrees/alphred-story-1-z9y8x7';
    const createdBranch = 'alphred/story/1-z9y8x7';
    const competingPath = '/tmp/alphred/worktrees/alphred-story-1-d4e5f6';
    const competingBranch = 'alphred/story/1-d4e5f6';
    const removeWorktreeMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: originalPath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:45:00.000Z',
      occurredAt: '2026-03-06T01:45:00.000Z',
    });

    const createWorktreeMock = vi.fn(async () => {
      updateStoryWorkspace(db, {
        storyWorkspaceId: existing.id,
        worktreePath: competingPath,
        branch: competingBranch,
        baseBranch: 'main',
        baseCommitHash: 'ghi789',
        status: 'active',
        statusReason: null,
        lastReconciledAt: '2026-03-06T01:46:30.000Z',
        removedAt: null,
        occurredAt: '2026-03-06T01:46:30.000Z',
      });

      return {
        path: createdPath,
        branch: createdBranch,
        commit: 'def456',
      };
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [],
        pathExists: async path => path === seed.repository.localPath,
        createWorktree: createWorktreeMock,
        removeWorktree: removeWorktreeMock,
        deleteBranch: deleteBranchMock,
        now: () => '2026-03-06T01:47:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} must be removed before it can be recreated.`,
      details: {
        currentStatus: 'active',
        allowedStatuses: ['removed'],
      },
    });

    expect(createWorktreeMock).toHaveBeenCalledOnce();
    expect(removeWorktreeMock).toHaveBeenCalledWith(seed.repository.localPath, createdPath);
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, createdBranch);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      id: existing.id,
      worktreePath: competingPath,
      branch: competingBranch,
      baseCommitHash: 'ghi789',
      status: 'active',
      statusReason: null,
      removedAt: null,
    });
  });

  it('rejects recreate when the current workspace is still active', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const createWorktreeMock = vi.fn(createDependencies(seed.repository).createWorktree);

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
        createWorktree: createWorktreeMock,
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} must be removed before it can be recreated.`,
      details: {
        currentStatus: 'active',
        allowedStatuses: ['removed'],
      },
    });

    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects recreate when removed-state repair degrades the workspace back to stale', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    let workspacePathExists = true;
    const createWorktreeMock = vi.fn(createDependencies(seed.repository).createWorktree);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:47:00.000Z',
      occurredAt: '2026-03-06T01:47:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: async () => [
          {
            path: workspacePath,
            branch: 'alphred/story/1-a1b2c3',
            commit: 'abc123',
          },
        ],
        pathExists: async path => path === seed.repository.localPath || (path === workspacePath && workspacePathExists),
        removeWorktree: async () => undefined,
        removePath: async () => {
          workspacePathExists = false;
        },
        createWorktree: createWorktreeMock,
        now: () => '2026-03-06T01:48:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} must be removed before it can be recreated.`,
      details: {
        currentStatus: 'stale',
        allowedStatuses: ['removed'],
      },
    });

    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'stale',
      statusReason: 'removed_state_drift',
      removedAt: null,
    });
  });

  it('returns conflict without downgrading the row when failed repair loses a concurrent recreate race', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const repositoryLocalPath = seed.repository.localPath ?? '/tmp/alphred/repos/github/octocat/demo-repo';
    const originalPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const recreatedPath = '/tmp/alphred/worktrees/alphred-story-1-d4e5f6';
    const originalBranch = 'alphred/story/1-a1b2c3';
    const recreatedBranch = 'alphred/story/1-d4e5f6';
    let registeredWorktrees: WorktreeInfo[] = [
      {
        path: originalPath,
        branch: originalBranch,
        commit: 'abc123',
      },
    ];
    const existingPaths = new Set([repositoryLocalPath, originalPath]);
    let repairRaceTriggered = false;
    let concurrentRecreateResult:
      | {
          workspace: {
            path: string;
            branch: string;
            status: string;
          };
        }
      | null = null;
    const removeWorktreeMock = vi.fn(async (_repositoryPath: string, workspacePath: string) => {
      registeredWorktrees = registeredWorktrees.filter(entry => entry.path !== workspacePath);
    });
    const removePathMock = vi.fn(async (workspacePath: string) => {
      existingPaths.delete(workspacePath);
    });
    const deleteBranchMock = vi.fn(async () => undefined);
    const createWorktreeMock = vi.fn(async () => {
      registeredWorktrees = [
        {
          path: recreatedPath,
          branch: recreatedBranch,
          commit: 'def456',
        },
      ];
      existingPaths.add(recreatedPath);

      return {
        path: recreatedPath,
        branch: recreatedBranch,
        commit: 'def456',
      };
    });
    const listWorktreesMock = vi.fn(async () => {
      if (!repairRaceTriggered && !existingPaths.has(originalPath)) {
        repairRaceTriggered = true;
        concurrentRecreateResult = await operations.recreateStoryWorkspace({
          repositoryId: seed.repositoryId,
          storyId: seed.storyId,
        });
        throw new Error('transient worktree inspection failure');
      }

      return registeredWorktrees;
    });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: originalPath,
      branch: originalBranch,
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:47:00.000Z',
      occurredAt: '2026-03-06T01:47:00.000Z',
    });

    const nowValues = ['2026-03-06T01:48:00.000Z', '2026-03-06T01:49:00.000Z'];
    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: listWorktreesMock,
        pathExists: async path => existingPaths.has(path),
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
        createWorktree: createWorktreeMock,
        now: () => nowValues.shift() ?? '2026-03-06T01:49:00.000Z',
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} must be removed before it can be recreated.`,
      details: {
        storyWorkspaceId: existing.id,
        storyId: seed.storyId,
        currentStatus: 'active',
        allowedStatuses: ['removed'],
      },
    });

    expect(repairRaceTriggered).toBe(true);
    expect(removeWorktreeMock).toHaveBeenCalledWith(repositoryLocalPath, originalPath);
    expect(removePathMock).toHaveBeenCalledWith(originalPath);
    expect(deleteBranchMock).toHaveBeenCalledWith(repositoryLocalPath, originalBranch);
    expect(createWorktreeMock).toHaveBeenCalledOnce();
    expect(concurrentRecreateResult).toMatchObject({
      workspace: {
        path: recreatedPath,
        branch: recreatedBranch,
        status: 'active',
      },
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      id: existing.id,
      worktreePath: recreatedPath,
      branch: recreatedBranch,
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      removedAt: null,
      lastReconciledAt: '2026-03-06T01:49:00.000Z',
    });
  });

  it('rejects recreate when a removed workspace path is outside the managed worktree root', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const workspacePath = '/tmp/elsewhere/alphred-story-1-a1b2c3';
    const listWorktreesMock = vi.fn(async () => []);
    const createWorktreeMock = vi.fn(createDependencies(seed.repository).createWorktree);
    const removeWorktreeMock = vi.fn(async () => undefined);
    const removePathMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: workspacePath,
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:47:30.000Z',
      occurredAt: '2026-03-06T01:47:30.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        listWorktrees: listWorktreesMock,
        createWorktree: createWorktreeMock,
        removeWorktree: removeWorktreeMock,
        removePath: removePathMock,
        deleteBranch: deleteBranchMock,
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.recreateStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} points outside the managed worktree root and cannot be modified safely.`,
      details: {
        storyWorkspaceId: existing.id,
        storyId: seed.storyId,
        worktreePath: workspacePath,
        managedWorktreeRoot: '/tmp/alphred/worktrees',
        reason: 'unmanaged_worktree_path',
      },
    });

    expect(listWorktreesMock).not.toHaveBeenCalled();
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removePathMock).not.toHaveBeenCalled();
    expect(deleteBranchMock).not.toHaveBeenCalled();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:47:30.000Z',
      worktreePath: workspacePath,
    });
  });

  it('rejects recreate requests when the repository is archived or the story is done', async () => {
    const archivedDb = createMigratedDb();
    const archivedSeed = seedRepositoryAndStory(archivedDb, { archivedAt: '2026-03-06T00:00:00.000Z' });

    const archivedOperations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(archivedDb),
      dependencies: createDependencies(archivedSeed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      archivedOperations.recreateStoryWorkspace({
        repositoryId: archivedSeed.repositoryId,
        storyId: archivedSeed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Repository "${archivedSeed.repository.name}" is archived. Restore it before recreating a story workspace.`,
    });

    const doneDb = createMigratedDb();
    const doneSeed = seedRepositoryAndStory(doneDb, { storyStatus: 'Done' });

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
      message: `Story id=${doneSeed.storyId} is already Done. Story workspaces cannot be recreated for done stories.`,
    });
  });

  it('rejects create requests when the repository is archived or the story is done', async () => {
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
      message: `Repository "${archivedSeed.repository.name}" is archived. Restore it before creating a story workspace.`,
    });

    const doneDb = createMigratedDb();
    const doneSeed = seedRepositoryAndStory(doneDb, { storyStatus: 'Done' });

    const doneOperations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(doneDb),
      dependencies: createDependencies(doneSeed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      doneOperations.createStoryWorkspace({
        repositoryId: doneSeed.repositoryId,
        storyId: doneSeed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story id=${doneSeed.storyId} is already Done. Story workspaces cannot be created for done stories.`,
    });
  });

  it('rejects create requests when a workspace row already exists', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const createWorktreeMock = vi.fn(createDependencies(seed.repository).createWorktree);

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
        createWorktree: createWorktreeMock,
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} already exists. Reconcile it instead of creating a new one.`,
      details: {
        storyId: seed.storyId,
        currentStatus: 'active',
        allowedActions: ['reconcile'],
      },
    });

    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('rolls back and reports conflict when the insert loses a duplicate-create race', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const createdPath = '/tmp/alphred/worktrees/alphred-story-1-z9y8x7';
    const createdBranch = 'alphred/story/1-z9y8x7';
    const competingPath = '/tmp/alphred/worktrees/alphred-story-1-a1b2c3';
    const competingBranch = 'alphred/story/1-a1b2c3';
    const removeWorktreeMock = vi.fn(async () => undefined);
    const deleteBranchMock = vi.fn(async () => undefined);
    const createWorktreeMock = vi.fn(async () => {
      insertStoryWorkspace(db, {
        repositoryId: seed.repositoryId,
        storyWorkItemId: seed.storyId,
        worktreePath: competingPath,
        branch: competingBranch,
        baseBranch: 'main',
        baseCommitHash: 'abc123',
        occurredAt: '2026-03-05T10:00:00.000Z',
      });

      return {
        path: createdPath,
        branch: createdBranch,
        commit: 'def456',
      };
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository, {
        createWorktree: createWorktreeMock,
        removeWorktree: removeWorktreeMock,
        deleteBranch: deleteBranchMock,
      }),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} already exists. Reconcile it instead of creating a new one.`,
      details: {
        storyId: seed.storyId,
        currentStatus: 'active',
        allowedActions: ['reconcile'],
      },
    });

    expect(createWorktreeMock).toHaveBeenCalledOnce();
    expect(removeWorktreeMock).toHaveBeenCalledWith(seed.repository.localPath, createdPath);
    expect(deleteBranchMock).toHaveBeenCalledWith(seed.repository.localPath, createdBranch);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: competingPath,
      branch: competingBranch,
      status: 'active',
    });
  });

  it('rolls back a live created worktree and branch when the insert loses a duplicate-create race', async () => {
    const fixture = await createLiveGitFixture();
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, {
      localPath: fixture.repositoryPath,
      storyStatus: 'Approved',
    });
    const competingPath = join(fixture.sandboxDir, 'worktrees', 'competing-story-workspace');
    const competingBranch = 'alphred/story/1-competing';
    let createdWorktree: WorktreeInfo | null = null;

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: async () => ({
          action: 'fetched' as const,
          repository: seed.repository,
          sync: {
            mode: 'fetch' as const,
            strategy: null,
            branch: seed.repository.defaultBranch,
            status: 'fetched' as const,
            conflictMessage: null,
          },
        }),
        createWorktree: async (repoDir, worktreeBase, params) => {
          const liveWorktree = await createGitWorktree(repoDir, worktreeBase, params);
          createdWorktree = liveWorktree;
          insertStoryWorkspace(db, {
            repositoryId: seed.repositoryId,
            storyWorkItemId: seed.storyId,
            worktreePath: competingPath,
            branch: competingBranch,
            baseBranch: 'main',
            baseCommitHash: liveWorktree.commit,
            occurredAt: '2026-03-06T02:04:00.000Z',
          });

          return liveWorktree;
        },
        now: () => '2026-03-06T02:05:00.000Z',
      },
      environment: fixture.gitEnvironment,
    });

    await withGitEnvironment(fixture.gitEnvironment, async () => {
      await expect(
        operations.createStoryWorkspace({
          repositoryId: seed.repositoryId,
          storyId: seed.storyId,
        }),
      ).rejects.toMatchObject({
        code: 'conflict',
        status: 409,
        message: `Story workspace for story id=${seed.storyId} already exists. Reconcile it instead of creating a new one.`,
        details: {
          storyId: seed.storyId,
          currentStatus: 'active',
          allowedActions: ['reconcile'],
        },
      });
    });

    const liveWorktree = requireLiveWorktree(createdWorktree);
    const worktreeList = await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'], fixture.gitEnvironment);

    expect(await pathExists(liveWorktree.path)).toBe(false);
    expect(worktreeList).not.toContain(`worktree ${liveWorktree.path}`);
    await expect(
      runGit(
        fixture.repositoryPath,
        ['rev-parse', '--verify', `refs/heads/${liveWorktree.branch}`],
        fixture.gitEnvironment,
      ),
    ).rejects.toThrow();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: competingPath,
      branch: competingBranch,
      baseCommitHash: fixture.initialCommit,
      status: 'active',
    });
  });

  it('cleans up a live worktree and deletes its branch from git', async () => {
    const fixture = await createLiveGitFixture();
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, {
      localPath: fixture.repositoryPath,
      storyStatus: 'Approved',
    });
    const liveWorktree = await withGitEnvironment(fixture.gitEnvironment, async () =>
      createGitWorktree(fixture.repositoryPath, join(fixture.sandboxDir, 'worktrees'), {
        branch: 'alphred/story/1-a1b2c3',
        baseRef: 'main',
      }),
    );

    insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: liveWorktree.path,
      branch: liveWorktree.branch,
      baseBranch: 'main',
      baseCommitHash: liveWorktree.commit,
      occurredAt: '2026-03-06T02:06:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: async () => ({
          action: 'fetched' as const,
          repository: seed.repository,
          sync: {
            mode: 'fetch' as const,
            strategy: null,
            branch: seed.repository.defaultBranch,
            status: 'fetched' as const,
            conflictMessage: null,
          },
        }),
        now: () => '2026-03-06T02:07:00.000Z',
      },
      environment: fixture.gitEnvironment,
    });

    const cleaned = await withGitEnvironment(fixture.gitEnvironment, async () =>
      operations.cleanupStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    );

    expect(cleaned.workspace).toMatchObject({
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T02:07:00.000Z',
      lastReconciledAt: '2026-03-06T02:07:00.000Z',
    });
    expect(await pathExists(liveWorktree.path)).toBe(false);
    expect(
      await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'], fixture.gitEnvironment),
    ).not.toContain(`worktree ${liveWorktree.path}`);
    await expect(
      runGit(
        fixture.repositoryPath,
        ['rev-parse', '--verify', `refs/heads/${liveWorktree.branch}`],
        fixture.gitEnvironment,
      ),
    ).rejects.toThrow();
  });

  it('surfaces rollback cleanup failure distinctly after a live worktree create succeeds', async () => {
    const fixture = await createLiveGitFixture();
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, {
      localPath: fixture.repositoryPath,
      storyStatus: 'Approved',
    });
    const competingPath = join(fixture.sandboxDir, 'worktrees', 'competing-story-workspace');
    const competingBranch = 'alphred/story/1-competing';
    let createdWorktree: WorktreeInfo | null = null;

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: {
        ensureRepositoryClone: async () => ({
          action: 'fetched' as const,
          repository: seed.repository,
          sync: {
            mode: 'fetch' as const,
            strategy: null,
            branch: seed.repository.defaultBranch,
            status: 'fetched' as const,
            conflictMessage: null,
          },
        }),
        createWorktree: async (repoDir, worktreeBase, params) => {
          const liveWorktree = await createGitWorktree(repoDir, worktreeBase, params);
          createdWorktree = liveWorktree;
          insertStoryWorkspace(db, {
            repositoryId: seed.repositoryId,
            storyWorkItemId: seed.storyId,
            worktreePath: competingPath,
            branch: competingBranch,
            baseBranch: 'main',
            baseCommitHash: liveWorktree.commit,
            occurredAt: '2026-03-06T02:09:00.000Z',
          });

          return liveWorktree;
        },
        deleteBranch: async () => {
          throw new Error('simulated branch delete failure');
        },
        now: () => '2026-03-06T02:10:00.000Z',
      },
      environment: fixture.gitEnvironment,
    });

    const thrown = await withGitEnvironment(fixture.gitEnvironment, async () =>
      operations
        .createStoryWorkspace({
          repositoryId: seed.repositoryId,
          storyId: seed.storyId,
        })
        .catch(error => error),
    );

    const liveWorktree = requireLiveWorktree(createdWorktree);

    expect(thrown).toMatchObject({
      code: 'internal_error',
      status: 500,
      message: `Unable to roll back story workspace create failure for story id=${seed.storyId}.`,
      details: {
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
        branch: liveWorktree.branch,
        worktreePath: liveWorktree.path,
      },
    });
    expect(await pathExists(liveWorktree.path)).toBe(false);
    expect(
      await runGit(
        fixture.repositoryPath,
        ['rev-parse', '--verify', `refs/heads/${liveWorktree.branch}`],
        fixture.gitEnvironment,
      ),
    ).toBe(fixture.initialCommit);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: competingPath,
      branch: competingBranch,
      baseCommitHash: fixture.initialCommit,
      status: 'active',
    });
  });

  it('rejects create requests when only a removed workspace row exists', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db, { storyStatus: 'Approved' });
    const existing = insertStoryWorkspace(db, {
      repositoryId: seed.repositoryId,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-1-a1b2c3',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    updateStoryWorkspace(db, {
      storyWorkspaceId: existing.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-06T01:21:00.000Z',
      occurredAt: '2026-03-06T01:21:00.000Z',
    });

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: `Story workspace for story id=${seed.storyId} already exists in removed state.`,
      details: {
        storyId: seed.storyId,
        currentStatus: 'removed',
      },
    });
  });

  it('returns not_found when reconcile is requested before a workspace exists', async () => {
    const db = createMigratedDb();
    const seed = seedRepositoryAndStory(db);

    const operations = createStoryWorkspaceOperations({
      withDatabase: createWithDatabase(db),
      dependencies: createDependencies(seed.repository),
      environment: createTestEnvironment(),
    });

    await expect(
      operations.reconcileStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: `Story workspace for story id=${seed.storyId} was not found.`,
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toBeNull();
  });
});
