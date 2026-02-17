import { sql } from 'drizzle-orm';
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

  it('defaults commitHash to null, returns null for missing ids, and lists all statuses when unfiltered', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'ops',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/ops.git',
      remoteRef: 'acme/ops',
      localPath: '/tmp/alphred/repos/github/acme/ops',
      cloneStatus: 'cloned',
    });

    const first = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/ops-first',
      branch: 'alphred/design_tree/ops-first',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const second = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/ops-second',
      branch: 'alphred/design_tree/ops-second',
      commitHash: 'xyz123',
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const removed = markRunWorktreeRemoved(db, {
      runWorktreeId: second.id,
      occurredAt: '2026-01-01T00:02:00.000Z',
    });

    expect(first.commitHash).toBeNull();
    expect(getRunWorktreeById(db, 9_999_999)).toBeNull();
    expect(listRunWorktreesForRun(db, runId)).toEqual([first, removed]);
  });

  it('throws when an inserted row is deleted before readback', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'cleanup',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/cleanup.git',
      remoteRef: 'acme/cleanup',
      localPath: '/tmp/alphred/repos/github/acme/cleanup',
      cloneStatus: 'cloned',
    });

    db.run(sql`DROP TRIGGER IF EXISTS run_worktrees_test_delete_after_insert`);
    db.run(sql`CREATE TRIGGER run_worktrees_test_delete_after_insert
      AFTER INSERT ON run_worktrees
      FOR EACH ROW
      BEGIN
        DELETE FROM run_worktrees WHERE id = NEW.id;
      END`);

    expect(() =>
      insertRunWorktree(db, {
        workflowRunId: runId,
        repositoryId: repository.id,
        worktreePath: '/tmp/alphred/worktrees/cleanup',
        branch: 'alphred/design_tree/cleanup',
      }),
    ).toThrow('Run-worktree insert did not return a row');
  });

  it('throws when a removed row is deleted before readback', () => {
    const db = createMigratedDb();
    const runId = seedWorkflowRun(db);
    const repository = insertRepository(db, {
      name: 'mobile-web',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/mobile-web.git',
      remoteRef: 'acme/mobile-web',
      localPath: '/tmp/alphred/repos/github/acme/mobile-web',
      cloneStatus: 'cloned',
    });

    const inserted = insertRunWorktree(db, {
      workflowRunId: runId,
      repositoryId: repository.id,
      worktreePath: '/tmp/alphred/worktrees/mobile-web',
      branch: 'alphred/design_tree/mobile-web',
    });

    db.run(sql`DROP TRIGGER IF EXISTS run_worktrees_test_delete_after_remove`);
    db.run(sql`CREATE TRIGGER run_worktrees_test_delete_after_remove
      AFTER UPDATE OF status ON run_worktrees
      FOR EACH ROW
      WHEN NEW.status = 'removed'
      BEGIN
        DELETE FROM run_worktrees WHERE id = NEW.id;
      END`);

    expect(() =>
      markRunWorktreeRemoved(db, {
        runWorktreeId: inserted.id,
      }),
    ).toThrow('Run-worktree disappeared after removal update');
  });
});
