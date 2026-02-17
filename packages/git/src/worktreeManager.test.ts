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
});
