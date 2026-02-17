import { describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  insertRepository,
  insertRunWorktree,
  listRunWorktreesForRun,
  markRunWorktreeRemoved,
  migrateDatabase,
  workflowRuns,
  workflowTrees,
} from '@alphred/db';
import { WorktreeManager } from './worktreeManager.js';

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedRun(db: ReturnType<typeof createDatabase>): number {
  const tree = db
    .insert(workflowTrees)
    .values({
      treeKey: 'design_tree',
      version: 1,
      name: 'Design Tree',
    })
    .returning({ id: workflowTrees.id })
    .get();

  const run = db
    .insert(workflowRuns)
    .values({
      workflowTreeId: tree.id,
      status: 'pending',
    })
    .returning({ id: workflowRuns.id })
    .get();

  return run.id;
}

describe('WorktreeManager', () => {
  it('creates run worktrees using registry lookup + branch-template context and persists tracking rows', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      defaultBranch: 'main',
      branchTemplate: 'alphred/{tree-key}/{run-id}-{node-key}',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
      cloneStatus: 'pending',
    });

    const ensureRepositoryClone = vi.fn(async () => ({
      repository: {
        ...repository,
        localPath: '/tmp/alphred/repos/github/acme/frontend',
        cloneStatus: 'cloned' as const,
      },
      action: 'fetched' as const,
    }));
    const createWorktree = vi.fn(async () => ({
      path: '/tmp/alphred/worktrees/alphred-design-tree-1',
      branch: 'alphred/design_tree/1-implement',
      commit: 'abc123',
    }));

    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone,
      createWorktree,
    });

    const created = await manager.createRunWorktree({
      repoName: 'frontend',
      treeKey: 'design_tree',
      runId,
      nodeKey: 'implement',
    });

    expect(ensureRepositoryClone).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledWith(
      '/tmp/alphred/repos/github/acme/frontend',
      '/tmp/alphred/worktrees',
      {
        branchTemplate: 'alphred/{tree-key}/{run-id}-{node-key}',
        branchContext: {
          treeKey: 'design_tree',
          runId,
          nodeKey: 'implement',
        },
        baseRef: 'main',
      },
    );
    expect(created.runId).toBe(runId);
    expect(created.repositoryId).toBe(repository.id);
    expect(created.branch).toBe('alphred/design_tree/1-implement');
    expect(created.commitHash).toBe('abc123');

    const active = listRunWorktreesForRun(db, runId, { status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0]?.branch).toBe('alphred/design_tree/1-implement');
  });

  it('cleanupRun removes all active worktrees and marks them removed', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'backend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/backend.git',
      remoteRef: 'acme/backend',
      defaultBranch: 'main',
      localPath: '/tmp/alphred/repos/github/acme/backend',
      cloneStatus: 'cloned',
    });

    const first = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/first',
      branch: 'alphred/design_tree/first',
      commitHash: '111111',
    });
    const second = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/second',
      branch: 'alphred/design_tree/second',
      commitHash: '222222',
    });
    const removeWorktree = vi.fn(async () => undefined);

    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      removeWorktree,
    });

    await manager.cleanupRun(runId);

    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/alphred/repos/github/acme/backend', first.worktreePath);
    expect(removeWorktree).toHaveBeenCalledWith('/tmp/alphred/repos/github/acme/backend', second.worktreePath);
    expect(listRunWorktreesForRun(db, runId, { status: 'active' })).toEqual([]);
    expect(listRunWorktreesForRun(db, runId, { status: 'removed' })).toHaveLength(2);
  });

  it('throws when createRunWorktree targets an unknown repository', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      createWorktree: vi.fn(),
    });

    await expect(
      manager.createRunWorktree({
        repoName: 'does-not-exist',
        treeKey: 'design_tree',
        runId,
      }),
    ).rejects.toThrow('Repository "does-not-exist" was not found in the registry.');
  });

  it('throws when ensureRepositoryClone returns a repository without localPath', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'frontend-no-path',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend-no-path.git',
      remoteRef: 'acme/frontend-no-path',
      defaultBranch: 'main',
      cloneStatus: 'pending',
      localPath: null,
    });
    const createWorktree = vi.fn(async () => ({
      path: '/tmp/alphred/worktrees/frontend-no-path',
      branch: 'alphred/design_tree/1',
      commit: 'abc123',
    }));
    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(async () => ({
        repository: {
          ...repository,
          localPath: null,
          cloneStatus: 'cloned' as const,
        },
        action: 'fetched' as const,
      })),
      createWorktree,
    });

    await expect(
      manager.createRunWorktree({
        repoName: 'frontend-no-path',
        treeKey: 'design_tree',
        runId,
      }),
    ).rejects.toThrow('Repository "frontend-no-path" does not have a local clone path.');
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('lists only active run worktrees', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'list-active',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/list-active.git',
      remoteRef: 'acme/list-active',
      defaultBranch: 'main',
      localPath: '/tmp/alphred/repos/github/acme/list-active',
      cloneStatus: 'cloned',
    });

    const active = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/list-active',
      branch: 'alphred/design_tree/list-active',
      commitHash: 'abc123',
    });
    const removed = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/list-removed',
      branch: 'alphred/design_tree/list-removed',
      commitHash: 'def456',
    });
    markRunWorktreeRemoved(db, {
      runWorktreeId: removed.id,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
    });

    await expect(manager.listRunWorktrees(runId)).resolves.toEqual([
      expect.objectContaining({
        id: active.id,
        runId,
        repositoryId: repository.id,
      }),
    ]);
  });

  it('treats removeRunWorktree as idempotent for already-removed rows', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'mobile',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/mobile.git',
      remoteRef: 'acme/mobile',
      defaultBranch: 'main',
      localPath: '/tmp/alphred/repos/github/acme/mobile',
      cloneStatus: 'cloned',
    });

    const row = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/mobile',
      branch: 'alphred/design_tree/mobile',
      commitHash: '333333',
    });
    markRunWorktreeRemoved(db, {
      runWorktreeId: row.id,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const removeWorktree = vi.fn(async () => undefined);
    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      removeWorktree,
    });

    await manager.removeRunWorktree(row.id);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('throws when removeRunWorktree receives an unknown worktree id', async () => {
    const db = createMigratedDb();
    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      removeWorktree: vi.fn(async () => undefined),
    });

    await expect(manager.removeRunWorktree(123_456)).rejects.toThrow('Run-worktree id=123456 was not found.');
  });

  it('throws when removeRunWorktree cannot load the linked repository', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'orphan-worktree-repo',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/orphan-worktree-repo.git',
      remoteRef: 'acme/orphan-worktree-repo',
      defaultBranch: 'main',
      localPath: '/tmp/alphred/repos/github/acme/orphan-worktree-repo',
      cloneStatus: 'cloned',
    });
    const worktree = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/orphan-worktree',
      branch: 'alphred/design_tree/orphan-worktree',
      commitHash: 'abc123',
    });
    const sqlite = (db as unknown as {
      $client: {
        pragma: (statement: string) => unknown;
        prepare: (statement: string) => { run: (id: number) => unknown };
      };
    }).$client;
    sqlite.pragma('foreign_keys = OFF');
    sqlite.prepare('DELETE FROM repositories WHERE id = ?').run(repository.id);
    sqlite.pragma('foreign_keys = ON');

    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      removeWorktree: vi.fn(async () => undefined),
    });

    await expect(manager.removeRunWorktree(worktree.id)).rejects.toThrow(
      `Repository id=${repository.id} for run-worktree id=${worktree.id} was not found.`,
    );
  });

  it('throws when removeRunWorktree repository row lacks localPath', async () => {
    const db = createMigratedDb();
    const runId = seedRun(db);
    const repository = insertRepository(db, {
      name: 'no-local-path',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/no-local-path.git',
      remoteRef: 'acme/no-local-path',
      defaultBranch: 'main',
      localPath: null,
      cloneStatus: 'pending',
    });
    const worktree = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/no-local-path',
      branch: 'alphred/design_tree/no-local-path',
      commitHash: 'abc123',
    });
    const removeWorktree = vi.fn(async () => undefined);
    const manager = new WorktreeManager(db, {
      worktreeBase: '/tmp/alphred/worktrees',
      ensureRepositoryClone: vi.fn(),
      removeWorktree,
    });

    await expect(manager.removeRunWorktree(worktree.id)).rejects.toThrow(
      `Repository "${repository.name}" has no local_path; cannot remove run-worktree id=${worktree.id}.`,
    );
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});
