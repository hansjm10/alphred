import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { migrateDatabase } from './migrate.js';
import {
  getStoryWorkspaceById,
  getStoryWorkspaceByStoryWorkItemId,
  insertRepository,
  insertStoryWorkspace,
  listStoryWorkspacesForRepository,
  workItems,
} from './index.js';

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function seedStoryWorkItem(db: ReturnType<typeof createDatabase>, params: { repositoryName: string; storyTitle: string }) {
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
  it('inserts story workspace rows and resolves them by id and story', () => {
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
      createdAt: '2026-03-05T10:00:00.000Z',
      updatedAt: '2026-03-05T10:00:00.000Z',
    });

    expect(getStoryWorkspaceById(db, inserted.id)).toEqual(inserted);
    expect(getStoryWorkspaceByStoryWorkItemId(db, seed.storyId)).toEqual(inserted);
  });

  it('lists story workspaces for a repository ordered by creation timestamp', () => {
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

    expect(listStoryWorkspacesForRepository(db, first.repository.id)).toEqual([workspaceOne, workspaceTwo]);
  });

  it('enforces one workspace per story and defaults baseCommitHash to null', () => {
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
});
