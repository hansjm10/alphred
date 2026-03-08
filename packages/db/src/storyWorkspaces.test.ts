import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  getStoryWorkspaceById,
  getStoryWorkspaceByStoryWorkItemId,
  insertRepository,
  insertStoryWorkspace,
  listStoryWorkspacesForRepository,
  reactivateRemovedStoryWorkspace,
  updateStoryWorkspace,
  workItems,
} from './index.js';

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedStoryWorkItem(
  db: ReturnType<typeof createDatabase>,
  params: {
    repositoryName: string;
    storyTitle: string;
  },
) {
  const repository = insertRepository(db, {
    name: params.repositoryName,
    provider: 'github',
    remoteUrl: `https://github.com/acme/${params.repositoryName}.git`,
    remoteRef: `acme/${params.repositoryName}`,
    localPath: `/tmp/alphred/repos/github/acme/${params.repositoryName}`,
    cloneStatus: 'cloned',
  });

  const story = db
    .insert(workItems)
    .values({
      repositoryId: repository.id,
      type: 'story',
      status: 'Draft',
      title: params.storyTitle,
      revision: 0,
    })
    .returning({ id: workItems.id })
    .get();

  return {
    repository,
    storyId: story.id,
  };
}

describe('story_workspaces lifecycle helpers', () => {
  it('inserts active story workspaces with lifecycle defaults and resolves them by id and story', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'frontend-story-workspace',
      storyTitle: 'Story workspace bootstrap',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-100',
      branch: 'alphred/story/100-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    expect(inserted).toEqual({
      id: inserted.id,
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/alphred-story-100',
      branch: 'alphred/story/100-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-05T10:00:00.000Z',
      createdAt: '2026-03-05T10:00:00.000Z',
      updatedAt: '2026-03-05T10:00:00.000Z',
      removedAt: null,
    });
    expect(getStoryWorkspaceById(db, inserted.id)).toEqual(inserted);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toEqual(inserted);
  });

  it('updates lifecycle fields and recreation fields in place', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-lifecycle',
      storyTitle: 'Lifecycle story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-lifecycle',
      branch: 'alphred/story/11-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const stale = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    expect(stale.status).toBe('stale');
    expect(stale.statusReason).toBe('missing_path');
    expect(stale.lastReconciledAt).toBe('2026-03-05T10:05:00.000Z');
    expect(stale.removedAt).toBeNull();
    expect(stale.updatedAt).toBe('2026-03-05T10:05:00.000Z');

    const removed = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-05T10:07:00.000Z',
      removedAt: '2026-03-05T10:07:00.000Z',
      occurredAt: '2026-03-05T10:07:00.000Z',
    });

    expect(removed.status).toBe('removed');
    expect(removed.statusReason).toBe('cleanup_requested');
    expect(removed.removedAt).toBe('2026-03-05T10:07:00.000Z');

    const recreated = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      worktreePath: '/tmp/alphred/worktrees/story-lifecycle-recreated',
      branch: 'alphred/story/11-d4e5f6',
      baseBranch: 'main',
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-05T10:10:00.000Z',
      removedAt: null,
      occurredAt: '2026-03-05T10:10:00.000Z',
    });

    expect(recreated).toMatchObject({
      id: inserted.id,
      worktreePath: '/tmp/alphred/worktrees/story-lifecycle-recreated',
      branch: 'alphred/story/11-d4e5f6',
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-05T10:10:00.000Z',
      removedAt: null,
      updatedAt: '2026-03-05T10:10:00.000Z',
    });
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toEqual(recreated);
  });

  it('reactivates removed story workspaces only while the row is still removed', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-reactivate-guard',
      storyTitle: 'Reactivate removed workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-reactivate-guard',
      branch: 'alphred/story/13-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const removed = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      removedAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    const reactivated = reactivateRemovedStoryWorkspace(db, {
      storyWorkspaceId: removed.id,
      worktreePath: '/tmp/alphred/worktrees/story-reactivate-guard-2',
      branch: 'alphred/story/13-d4e5f6',
      baseBranch: 'main',
      baseCommitHash: 'def456',
      lastReconciledAt: '2026-03-05T10:10:00.000Z',
      occurredAt: '2026-03-05T10:10:00.000Z',
    });

    expect(reactivated).toMatchObject({
      id: removed.id,
      worktreePath: '/tmp/alphred/worktrees/story-reactivate-guard-2',
      branch: 'alphred/story/13-d4e5f6',
      baseCommitHash: 'def456',
      status: 'active',
      statusReason: null,
      removedAt: null,
      lastReconciledAt: '2026-03-05T10:10:00.000Z',
      updatedAt: '2026-03-05T10:10:00.000Z',
    });

    expect(() =>
      reactivateRemovedStoryWorkspace(db, {
        storyWorkspaceId: removed.id,
        worktreePath: '/tmp/alphred/worktrees/story-reactivate-guard-3',
        branch: 'alphred/story/13-g7h8i9',
        baseBranch: 'main',
        baseCommitHash: 'ghi789',
        lastReconciledAt: '2026-03-05T10:15:00.000Z',
        occurredAt: '2026-03-05T10:15:00.000Z',
      }),
    ).toThrow(`Story workspace reactivation precondition failed for id=${removed.id}; expected status "removed".`);
  });

  it('throws when reactivating a workspace that does not exist', () => {
    const db = createMigratedDb();

    expect(() =>
      reactivateRemovedStoryWorkspace(db, {
        storyWorkspaceId: 9_999_999,
        worktreePath: '/tmp/alphred/worktrees/story-reactivate-missing',
        branch: 'alphred/story/missing',
        baseBranch: 'main',
      }),
    ).toThrow('Story workspace id=9999999 was not found for reactivation.');
  });

  it('applies update preconditions only while the row still has the expected status', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-update-guard',
      storyTitle: 'Update precondition guard',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-update-guard',
      branch: 'alphred/story/14-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        expectedStatus: 'removed',
        status: 'removed',
        statusReason: 'cleanup_requested',
        removedAt: '2026-03-05T10:05:00.000Z',
        occurredAt: '2026-03-05T10:05:00.000Z',
      }),
    ).toThrow(`Story workspace update precondition failed for id=${inserted.id}; expected status "removed".`);

    expect(getStoryWorkspaceById(db, inserted.id)).toEqual(inserted);
  });

  it('updates a workspace when the expected status still matches at write time', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-update-expected-status',
      storyTitle: 'Expected status update',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-update-expected-status',
      branch: 'alphred/story/15-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const updated = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      expectedStatus: 'active',
      status: 'stale',
      statusReason: 'missing_path',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    expect(updated).toMatchObject({
      id: inserted.id,
      status: 'stale',
      statusReason: 'missing_path',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
  });

  it('throws when an update without expectedStatus changes zero rows', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-update-noop-missing',
      storyTitle: 'Update no-op missing workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-update-noop-missing',
      branch: 'alphred/story/16-a1b2c3',
      baseBranch: 'main',
    });

    db.run(sql`DROP TRIGGER IF EXISTS story_workspaces_test_ignore_update_without_expected_status`);
    db.run(sql`CREATE TRIGGER story_workspaces_test_ignore_update_without_expected_status
      BEFORE UPDATE ON story_workspaces
      FOR EACH ROW
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        status: 'stale',
        statusReason: 'missing_path',
      }),
    ).toThrow(`Story workspace id=${inserted.id} was not found for update.`);
  });

  it('throws when an expected-status update changes zero rows', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-update-noop-expected-status',
      storyTitle: 'Update no-op expected status workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-update-noop-expected-status',
      branch: 'alphred/story/17-a1b2c3',
      baseBranch: 'main',
    });

    db.run(sql`DROP TRIGGER IF EXISTS story_workspaces_test_ignore_update_with_expected_status`);
    db.run(sql`CREATE TRIGGER story_workspaces_test_ignore_update_with_expected_status
      BEFORE UPDATE ON story_workspaces
      FOR EACH ROW
      BEGIN
        SELECT RAISE(IGNORE);
      END`);

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        expectedStatus: 'active',
        status: 'removed',
        statusReason: 'cleanup_requested',
        removedAt: '2026-03-05T10:05:00.000Z',
        occurredAt: '2026-03-05T10:05:00.000Z',
      }),
    ).toThrow(`Story workspace update precondition failed for id=${inserted.id}; expected status "active".`);
  });

  it('preserves updatedAt when reconciliation only advances lastReconciledAt', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-reconcile-metadata',
      storyTitle: 'Reconciliation metadata story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-reconcile-metadata',
      branch: 'alphred/story/12-a1b2c3',
      baseBranch: 'main',
      baseCommitHash: 'abc123',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });

    const reconciled = updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      removedAt: null,
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    expect(reconciled).toMatchObject({
      id: inserted.id,
      status: 'active',
      statusReason: null,
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      removedAt: null,
      updatedAt: '2026-03-05T10:00:00.000Z',
    });
  });

  it('lists story workspaces for a repository ordered by creation timestamp across statuses', () => {
    const db = createMigratedDb();
    const first = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-ordering',
      storyTitle: 'First story',
    });

    const secondStory = db
      .insert(workItems)
      .values({
        repositoryId: first.repository.id,
        type: 'story',
        status: 'Draft',
        title: 'Second story',
        revision: 0,
      })
      .returning({ id: workItems.id })
      .get();

    const workspaceOne = insertStoryWorkspace(db, {
      repositoryId: first.repository.id,
      storyWorkItemId: first.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-1',
      branch: 'alphred/story/1-a1b2c3',
      baseBranch: 'main',
      occurredAt: '2026-03-05T10:00:00.000Z',
    });
    const workspaceTwo = insertStoryWorkspace(db, {
      repositoryId: first.repository.id,
      storyWorkItemId: secondStory.id,
      worktreePath: '/tmp/alphred/worktrees/story-2',
      branch: 'alphred/story/2-a1b2c3',
      baseBranch: 'main',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    const removedWorkspaceTwo = updateStoryWorkspace(db, {
      storyWorkspaceId: workspaceTwo.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      lastReconciledAt: '2026-03-05T10:07:00.000Z',
      removedAt: '2026-03-05T10:07:00.000Z',
      occurredAt: '2026-03-05T10:07:00.000Z',
    });

    expect(listStoryWorkspacesForRepository(db, first.repository.id)).toEqual([workspaceOne, removedWorkspaceTwo]);
  });

  it('enforces one workspace per story, defaults nullable fields, and returns null for missing ids', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-unique',
      storyTitle: 'Unique story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-unique',
      branch: 'alphred/story/3-a1b2c3',
      baseBranch: 'main',
    });

    expect(inserted.baseCommitHash).toBeNull();
    expect(inserted.statusReason).toBeNull();
    expect(inserted.removedAt).toBeNull();
    expect(getStoryWorkspaceById(db, 9_999_999)).toBeNull();

    expect(() =>
      insertStoryWorkspace(db, {
        repositoryId: seed.repository.id,
        storyWorkItemId: seed.storyId,
        worktreePath: '/tmp/alphred/worktrees/story-unique-2',
        branch: 'alphred/story/3-d4e5f6',
        baseBranch: 'main',
      }),
    ).toThrow();
  });

  it('rejects inserts for non-story or cross-repository work items before writing', () => {
    const db = createMigratedDb();
    const repository = insertRepository(db, {
      name: 'story-workspace-preconditions',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/story-workspace-preconditions.git',
      remoteRef: 'acme/story-workspace-preconditions',
      localPath: '/tmp/alphred/repos/github/acme/story-workspace-preconditions',
      cloneStatus: 'cloned',
    });
    const otherRepository = insertRepository(db, {
      name: 'story-workspace-preconditions-other',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/story-workspace-preconditions-other.git',
      remoteRef: 'acme/story-workspace-preconditions-other',
      localPath: '/tmp/alphred/repos/github/acme/story-workspace-preconditions-other',
      cloneStatus: 'cloned',
    });

    const feature = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'feature',
        status: 'Draft',
        title: 'Not a story',
        revision: 0,
      })
      .returning({ id: workItems.id })
      .get();
    const otherStory = db
      .insert(workItems)
      .values({
        repositoryId: otherRepository.id,
        type: 'story',
        status: 'Draft',
        title: 'Other repository story',
        revision: 0,
      })
      .returning({ id: workItems.id })
      .get();

    expect(() =>
      insertStoryWorkspace(db, {
        repositoryId: repository.id,
        storyWorkItemId: feature.id,
        worktreePath: '/tmp/alphred/worktrees/story-invalid-feature',
        branch: 'alphred/story/feature',
        baseBranch: 'main',
      }),
    ).toThrow('expected work_item.type "story"');

    expect(() =>
      insertStoryWorkspace(db, {
        repositoryId: repository.id,
        storyWorkItemId: otherStory.id,
        worktreePath: '/tmp/alphred/worktrees/story-cross-repository',
        branch: 'alphred/story/cross-repository',
        baseBranch: 'main',
      }),
    ).toThrow(`expected repositoryId=${otherRepository.id}`);
  });

  it('cascades story workspace rows when deleting the story work item', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-cascade',
      storyTitle: 'Cascade story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-cascade',
      branch: 'alphred/story/4-a1b2c3',
      baseBranch: 'main',
    });

    db.delete(workItems).where(eq(workItems.id, seed.storyId)).run();

    expect(getStoryWorkspaceById(db, inserted.id)).toBeNull();
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toBeNull();
  });

  it('throws when an inserted row is deleted before readback', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-delete-after-insert',
      storyTitle: 'Insert cleanup story workspace',
    });

    db.run(sql`DROP TRIGGER IF EXISTS story_workspaces_test_delete_after_insert`);
    db.run(sql`CREATE TRIGGER story_workspaces_test_delete_after_insert
      AFTER INSERT ON story_workspaces
      FOR EACH ROW
      BEGIN
        DELETE FROM story_workspaces WHERE id = NEW.id;
      END`);

    expect(() =>
      insertStoryWorkspace(db, {
        repositoryId: seed.repository.id,
        storyWorkItemId: seed.storyId,
        worktreePath: '/tmp/alphred/worktrees/story-insert-delete',
        branch: 'alphred/story/5-a1b2c3',
        baseBranch: 'main',
      }),
    ).toThrow('Story workspace insert did not return a row');
  });

  it('throws when an updated row is deleted before readback', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-delete-after-update',
      storyTitle: 'Update cleanup story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-update-delete',
      branch: 'alphred/story/6-a1b2c3',
      baseBranch: 'main',
    });

    db.run(sql`DROP TRIGGER IF EXISTS story_workspaces_test_delete_after_update`);
    db.run(sql`CREATE TRIGGER story_workspaces_test_delete_after_update
      AFTER UPDATE ON story_workspaces
      FOR EACH ROW
      BEGIN
        DELETE FROM story_workspaces WHERE id = NEW.id;
      END`);

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        status: 'stale',
        statusReason: 'missing_path',
        lastReconciledAt: '2026-03-05T10:05:00.000Z',
      }),
    ).toThrow('Story workspace disappeared after update');
  });

  it('throws when a reactivated row is deleted before readback', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-delete-after-reactivate',
      storyTitle: 'Reactivate cleanup story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-reactivate-delete',
      branch: 'alphred/story/18-a1b2c3',
      baseBranch: 'main',
    });

    updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'removed',
      statusReason: 'cleanup_requested',
      removedAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    db.run(sql`DROP TRIGGER IF EXISTS story_workspaces_test_delete_after_reactivate`);
    db.run(sql`CREATE TRIGGER story_workspaces_test_delete_after_reactivate
      AFTER UPDATE ON story_workspaces
      FOR EACH ROW
      BEGIN
        DELETE FROM story_workspaces WHERE id = NEW.id;
      END`);

    expect(() =>
      reactivateRemovedStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        worktreePath: '/tmp/alphred/worktrees/story-reactivate-delete-2',
        branch: 'alphred/story/18-d4e5f6',
        baseBranch: 'main',
        occurredAt: '2026-03-05T10:10:00.000Z',
      }),
    ).toThrow('Story workspace disappeared after reactivation update');
  });

  it('rejects unknown story workspace status reasons on update', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-invalid-reason',
      storyTitle: 'Invalid reason story workspace',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-invalid-reason',
      branch: 'alphred/story/7-a1b2c3',
      baseBranch: 'main',
    });

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        statusReason: 'invalid_reason' as never,
      }),
    ).toThrow('Unknown story-workspace status reason: invalid_reason');
  });

  it('rejects non-null status reasons while the workspace remains active', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-active-reason',
      storyTitle: 'Active story workspace reason guard',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-active-reason',
      branch: 'alphred/story/8-a1b2c3',
      baseBranch: 'main',
    });

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        statusReason: 'cleanup_requested',
      }),
    ).toThrow('Story workspace status "active" requires statusReason to be null');
  });

  it('rejects reactivating a workspace without clearing the prior status reason', () => {
    const db = createMigratedDb();
    const seed = seedStoryWorkItem(db, {
      repositoryName: 'story-workspace-reactivate-reason',
      storyTitle: 'Reactivate story workspace reason guard',
    });

    const inserted = insertStoryWorkspace(db, {
      repositoryId: seed.repository.id,
      storyWorkItemId: seed.storyId,
      worktreePath: '/tmp/alphred/worktrees/story-reactivate-reason',
      branch: 'alphred/story/9-a1b2c3',
      baseBranch: 'main',
    });

    updateStoryWorkspace(db, {
      storyWorkspaceId: inserted.id,
      status: 'stale',
      statusReason: 'missing_path',
      lastReconciledAt: '2026-03-05T10:05:00.000Z',
      occurredAt: '2026-03-05T10:05:00.000Z',
    });

    expect(() =>
      updateStoryWorkspace(db, {
        storyWorkspaceId: inserted.id,
        status: 'active',
        occurredAt: '2026-03-05T10:10:00.000Z',
      }),
    ).toThrow('Story workspace status "active" requires statusReason to be null');
  });
});
