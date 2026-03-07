import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      defaultBranch: 'main',
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

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: process.env,
  });

  return stdout.trim();
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
};

function requireLiveWorktree(worktree: WorktreeInfo | null): WorktreeInfo {
  if (worktree === null) {
    throw new Error('Expected the live createWorktree helper to create a worktree before the duplicate insert race.');
  }

  return worktree;
}

async function createLiveGitFixture(): Promise<LiveGitFixture> {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'alphred-story-workspace-'));
  cleanupPaths.add(sandboxDir);

  const repositoryPath = join(sandboxDir, 'repo');
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(join(sandboxDir, 'worktrees'), { recursive: true });

  await runGit(repositoryPath, ['init']);
  await runGit(repositoryPath, ['config', 'user.email', 'alphred-tests@example.com']);
  await runGit(repositoryPath, ['config', 'user.name', 'Alphred Tests']);
  await runGit(repositoryPath, ['checkout', '-b', 'main']);
  await writeFile(join(repositoryPath, 'README.md'), '# fixture\n');
  await runGit(repositoryPath, ['add', 'README.md']);
  await runGit(repositoryPath, ['commit', '-m', 'initial']);

  return {
    sandboxDir,
    repositoryPath,
    initialCommit: await runGit(repositoryPath, ['rev-parse', 'HEAD']),
  };
}

function createLiveGitEnvironment(sandboxDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALPHRED_SANDBOX_DIR: sandboxDir,
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
      environment: createLiveGitEnvironment(fixture.sandboxDir),
    });

    const created = await operations.createStoryWorkspace({
      repositoryId: seed.repositoryId,
      storyId: seed.storyId,
    });

    const worktreeList = await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain']);
    const branchCommit = await runGit(fixture.repositoryPath, ['rev-parse', '--verify', `refs/heads/${created.workspace.branch}`]);
    const worktreeCommit = await runGit(created.workspace.path, ['rev-parse', 'HEAD']);

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
      environment: createLiveGitEnvironment(fixture.sandboxDir),
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

    const liveWorktree = requireLiveWorktree(createdWorktree);
    const worktreeList = await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain']);

    expect(await pathExists(liveWorktree.path)).toBe(false);
    expect(worktreeList).not.toContain(`worktree ${liveWorktree.path}`);
    await expect(
      runGit(fixture.repositoryPath, ['rev-parse', '--verify', `refs/heads/${liveWorktree.branch}`]),
    ).rejects.toThrow();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: competingPath,
      branch: competingBranch,
      baseCommitHash: fixture.initialCommit,
      status: 'active',
    });
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
      environment: createLiveGitEnvironment(fixture.sandboxDir),
    });

    const thrown = await operations
      .createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      })
      .catch(error => error);

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
      await runGit(fixture.repositoryPath, ['rev-parse', '--verify', `refs/heads/${liveWorktree.branch}`]),
    ).toBe(fixture.initialCommit);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toMatchObject({
      worktreePath: competingPath,
      branch: competingBranch,
      baseCommitHash: fixture.initialCommit,
      status: 'active',
    });
  });

  it('surfaces a distinct rollback cleanup failure after live worktree creation', async () => {
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
        removeWorktree: async () => {
          throw new Error('simulated removeWorktree failure');
        },
        now: () => '2026-03-06T02:10:00.000Z',
      },
      environment: createLiveGitEnvironment(fixture.sandboxDir),
    });

    const rollbackFailure = await operations
      .createStoryWorkspace({
        repositoryId: seed.repositoryId,
        storyId: seed.storyId,
      })
      .catch(error => error);
    const liveWorktree = requireLiveWorktree(createdWorktree);

    expect(rollbackFailure).toMatchObject({
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

    const worktreeList = await runGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain']);

    expect(await pathExists(liveWorktree.path)).toBe(true);
    expect(worktreeList).toContain(`worktree ${liveWorktree.path}`);
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
