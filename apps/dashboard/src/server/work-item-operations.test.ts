import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  eq,
  insertRepository,
  migrateDatabase,
  workItemEvents,
  workItems,
  type AlphredDatabase,
} from '@alphred/db';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner } from '@alphred/core';
import { createDashboardService, type DashboardServiceDependencies } from './dashboard-service';
import { DashboardIntegrationError } from './dashboard-errors';

function createHarness(): {
  db: AlphredDatabase;
  service: ReturnType<typeof createDashboardService>;
} {
  const db = createDatabase(':memory:');
  migrateDatabase(db);

  const dependencies: DashboardServiceDependencies = {
    openDatabase: () => db,
    migrateDatabase: input => migrateDatabase(input),
    closeDatabase: () => undefined,
    resolveProvider: () => {
      throw new Error('resolveProvider should not be called in this test');
    },
    createScmProvider: () => ({
      checkAuth: async () =>
        ({
          authenticated: true,
          user: 'tester',
          scopes: ['repo'],
        }) satisfies AuthStatus,
    }),
    ensureRepositoryClone: async params => ({
      action: 'fetched' as const,
      repository: {
        id: 1,
        name: params.repository.name,
        provider: params.repository.provider,
        remoteUrl: params.repository.remoteUrl,
        remoteRef: params.repository.remoteRef,
        defaultBranch: params.repository.defaultBranch ?? 'main',
        branchTemplate: null,
        localPath: '/tmp/repo',
        cloneStatus: 'cloned',
      } satisfies RepositoryConfig,
    }),
    createSqlWorkflowPlanner: inputDb => createSqlWorkflowPlanner(inputDb),
    createSqlWorkflowExecutor: (inputDb, options) => createSqlWorkflowExecutor(inputDb, options),
    createWorktreeManager: () => ({
      createRunWorktree: async () => ({
        id: 1,
        runId: 1,
        repositoryId: 1,
        path: '/tmp/worktree',
        branch: 'main',
        commitHash: null,
        createdAt: '2026-02-17T20:00:00.000Z',
      }),
      cleanupRun: async () => undefined,
    }),
  };

  return {
    db,
    service: createDashboardService({ dependencies }),
  };
}

describe('work-item-operations', () => {
  it('returns 409 on expectedRevision mismatch for field updates', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const inserted = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        revision: 2,
      })
      .run();
    const workItemId = Number(inserted.lastInsertRowid);

    await expect(
      service.updateWorkItemFields({
        repositoryId: repository.id,
        workItemId,
        expectedRevision: 1,
        title: 'Updated',
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });

  it('returns 409 on invalid status transition', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const inserted = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        revision: 0,
      })
      .run();
    const workItemId = Number(inserted.lastInsertRowid);

    await expect(
      service.moveWorkItemStatus({
        repositoryId: repository.id,
        workItemId,
        expectedRevision: 0,
        toStatus: 'Done',
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
  });

  it('requires non-empty actorLabel', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const inserted = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        revision: 0,
      })
      .run();
    const workItemId = Number(inserted.lastInsertRowid);

    try {
      service.updateWorkItemFields({
        repositoryId: repository.id,
        workItemId,
        expectedRevision: 0,
        title: 'Updated',
        actorType: 'human',
        actorLabel: '   ',
      });
      throw new Error('Expected actorLabel validation to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardIntegrationError);
      expect(error).toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    }
  });

  it('proposes and approves a story breakdown (Draft -> Ready for child tasks)', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const insertStory = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'story',
        status: 'NeedsBreakdown',
        title: 'Story',
        revision: 0,
      })
      .run();
    const storyId = Number(insertStory.lastInsertRowid);

    const proposed = await service.proposeStoryBreakdown({
      repositoryId: repository.id,
      storyId,
      expectedRevision: 0,
      actorType: 'human',
      actorLabel: 'alice',
      proposed: {
        tags: ['planning'],
        plannedFiles: ['src/a.ts'],
        links: ['workitem:parent:123'],
        tasks: [
          {
            title: 'Task A',
            plannedFiles: ['src/a.ts'],
            links: ['file:src/a.ts'],
          },
          {
            title: 'Task B',
            plannedFiles: ['src/b.ts'],
          },
        ],
      },
    });

    expect(proposed.story.status).toBe('BreakdownProposed');
    expect(proposed.tasks).toHaveLength(2);
    expect(proposed.tasks[0]?.status).toBe('Draft');

    const approved = await service.approveStoryBreakdown({
      repositoryId: repository.id,
      storyId,
      expectedRevision: proposed.story.revision,
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(approved.story.status).toBe('Approved');
    expect(approved.tasks).toHaveLength(2);
    for (const task of approved.tasks) {
      expect(task.status).toBe('Ready');
    }

    const eventRows = db
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.repositoryId, repository.id))
      .all();
    const eventTypes = eventRows.map(row => row.eventType);
    expect(eventTypes).toContain('breakdown_proposed');
    expect(eventTypes).toContain('breakdown_approved');
  });

  it('rejects approving a story breakdown when no child tasks exist', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const insertStory = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'story',
        status: 'BreakdownProposed',
        title: 'Story without tasks',
        revision: 0,
      })
      .run();
    const storyId = Number(insertStory.lastInsertRowid);

    await expect(
      service.approveStoryBreakdown({
        repositoryId: repository.id,
        storyId,
        expectedRevision: 0,
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Cannot approve breakdown without child tasks.',
    });
  });
});
