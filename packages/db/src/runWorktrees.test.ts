import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  getRunWorktreeById,
  insertRepository,
  insertRunWorktree,
  listRunWorktreesForRun,
  markRunWorktreeRemoved,
  workflowRuns,
  workflowTrees,
} from './index.js';

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedWorkflowRun(db: ReturnType<typeof createDatabase>): number {
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

describe('run_worktrees lifecycle helpers', () => {
  it('inserts run-worktrees and lists active records for a run', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath: '/tmp/alphred/repos/github/acme/frontend',
      cloneStatus: 'cloned',
    });

    const inserted = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/alphred-design-tree-1',
      branch: 'alphred/design_tree/1',
      commitHash: 'abc123',
    });

    expect(inserted.status).toBe('active');
    expect(inserted.removedAt).toBeNull();

    const active = listRunWorktreesForRun(db, runId, { status: 'active' });
    expect(active).toEqual([inserted]);
  });

  it('marks active run-worktrees as removed and filters status views', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'backend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/backend.git',
      remoteRef: 'acme/backend',
      localPath: '/tmp/alphred/repos/github/acme/backend',
      cloneStatus: 'cloned',
    });

    const inserted = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/alphred-design-tree-2',
      branch: 'alphred/design_tree/2',
      commitHash: 'def456',
    });

    const removed = markRunWorktreeRemoved(db, {
      runWorktreeId: inserted.id,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(removed.status).toBe('removed');
    expect(removed.removedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(listRunWorktreesForRun(db, runId, { status: 'active' })).toEqual([]);
    expect(listRunWorktreesForRun(db, runId, { status: 'removed' })).toEqual([removed]);
  });

  it('enforces active-only precondition for removal updates', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'mobile',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/mobile.git',
      remoteRef: 'acme/mobile',
      localPath: '/tmp/alphred/repos/github/acme/mobile',
      cloneStatus: 'cloned',
    });

    const inserted = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/alphred-design-tree-3',
      branch: 'alphred/design_tree/3',
      commitHash: 'ghi789',
    });

    markRunWorktreeRemoved(db, {
      runWorktreeId: inserted.id,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(() =>
      markRunWorktreeRemoved(db, {
        runWorktreeId: inserted.id,
      }),
    ).toThrow('Run-worktree removal precondition failed');

    expect(getRunWorktreeById(db, inserted.id)?.status).toBe('removed');
  });
});
