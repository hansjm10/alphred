import { describe, expect, it } from 'vitest';
import {
  and,
  createDatabase,
  eq,
  insertRepository,
  migrateDatabase,
  workItemEvents,
  workItemPolicies,
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
  it('returns board-event snapshots with lastEventId resume semantics', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const insertedWorkItem = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        revision: 0,
      })
      .run();
    const workItemId = Number(insertedWorkItem.lastInsertRowid);

    const firstEventId = Number(
      db.insert(workItemEvents)
        .values({
          repositoryId: repository.id,
          workItemId,
          eventType: 'created',
          actorType: 'human',
          actorLabel: 'alice',
          payload: { title: 'Task' },
          createdAt: '2026-03-02T18:50:00.000Z',
        })
        .run().lastInsertRowid,
    );

    const secondEventId = Number(
      db.insert(workItemEvents)
        .values({
          repositoryId: repository.id,
          workItemId,
          eventType: 'updated',
          actorType: 'agent',
          actorLabel: 'codex',
          payload: { changes: { title: 'Task v2' } },
          createdAt: '2026-03-02T18:50:01.000Z',
        })
        .run().lastInsertRowid,
    );

    const snapshot = await service.getRepositoryBoardEventsSnapshot({
      repositoryId: repository.id,
      lastEventId: firstEventId,
    });

    expect(snapshot).toEqual({
      repositoryId: repository.id,
      latestEventId: secondEventId,
      events: [
        {
          id: secondEventId,
          repositoryId: repository.id,
          workItemId,
          eventType: 'updated',
          actorType: 'agent',
          actorLabel: 'codex',
          payload: { changes: { title: 'Task v2' } },
          createdAt: '2026-03-02T18:50:01.000Z',
        },
      ],
    });
  });

  it('returns 404 for board-event snapshots when repository does not exist', async () => {
    const { service } = createHarness();

    await expect(
      service.getRepositoryBoardEventsSnapshot({
        repositoryId: 999,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('rejects negative board-event resume pointers', async () => {
    const { service } = createHarness();

    expect(() =>
      service.getRepositoryBoardEventsSnapshot({
        repositoryId: 1,
        lastEventId: -1,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
        status: 400,
        message: 'lastEventId must be a non-negative integer.',
      }),
    );
  });

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

  it('resolves effective policies for epics and tasks from repo defaults plus epic overrides', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const epicInsert = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'epic',
        status: 'Draft',
        title: 'Epic',
        revision: 0,
      })
      .run();
    const epicId = Number(epicInsert.lastInsertRowid);

    const storyInsert = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'story',
        status: 'Draft',
        title: 'Story',
        parentId: epicId,
        revision: 0,
      })
      .run();
    const storyId = Number(storyInsert.lastInsertRowid);

    const taskInsert = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        parentId: storyId,
        revision: 0,
      })
      .run();
    const taskId = Number(taskInsert.lastInsertRowid);

    const repoPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: null,
          payload: {
            allowedProviders: ['claude'],
            allowedModels: ['claude-3-7-sonnet'],
            allowedSkillIdentifiers: ['working-on-github-issue'],
            allowedMcpServerIdentifiers: ['github'],
            budgets: {
              maxConcurrentTasks: 6,
              maxConcurrentRuns: 2,
            },
            requiredGates: {
              breakdownApprovalRequired: true,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const epicPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicId,
          payload: {
            allowedProviders: ['codex'],
            budgets: {
              maxConcurrentTasks: 3,
            },
            requiredGates: {
              breakdownApprovalRequired: false,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const result = await service.listWorkItems(repository.id);
    const epic = result.workItems.find(item => item.id === epicId);
    const story = result.workItems.find(item => item.id === storyId);
    const task = result.workItems.find(item => item.id === taskId);

    expect(epic?.effectivePolicy).toEqual({
      appliesToType: 'epic',
      epicWorkItemId: epicId,
      repositoryPolicyId: repoPolicyId,
      epicPolicyId,
      policy: {
        allowedProviders: ['codex'],
        allowedModels: ['claude-3-7-sonnet'],
        allowedSkillIdentifiers: ['working-on-github-issue'],
        allowedMcpServerIdentifiers: ['github'],
        budgets: {
          maxConcurrentTasks: 3,
          maxConcurrentRuns: 2,
        },
        requiredGates: {
          breakdownApprovalRequired: false,
        },
      },
    });
    expect(story?.effectivePolicy ?? null).toBeNull();
    expect(task?.effectivePolicy).toEqual({
      appliesToType: 'task',
      epicWorkItemId: epicId,
      repositoryPolicyId: repoPolicyId,
      epicPolicyId,
      policy: {
        allowedProviders: ['codex'],
        allowedModels: ['claude-3-7-sonnet'],
        allowedSkillIdentifiers: ['working-on-github-issue'],
        allowedMcpServerIdentifiers: ['github'],
        budgets: {
          maxConcurrentTasks: 3,
          maxConcurrentRuns: 2,
        },
        requiredGates: {
          breakdownApprovalRequired: false,
        },
      },
    });

    await expect(
      service.getWorkItem({
        repositoryId: repository.id,
        workItemId: taskId,
      }),
    ).resolves.toMatchObject({
      workItem: {
        id: taskId,
        effectivePolicy: {
          appliesToType: 'task',
          epicWorkItemId: epicId,
          repositoryPolicyId: repoPolicyId,
          epicPolicyId,
        },
      },
    });
  });

  it('rejects policy overrides that target non-epic work items', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const taskInsert = db
      .insert(workItems)
      .values({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Task',
        revision: 0,
      })
      .run();
    const taskId = Number(taskInsert.lastInsertRowid);

    db.insert(workItemPolicies)
      .values({
        repositoryId: repository.id,
        epicWorkItemId: taskId,
        payload: {
          allowedProviders: ['codex'],
        },
      })
      .run();

    await expect(service.listWorkItems(repository.id)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: expect.stringContaining('not an epic'),
    });
  });

  it('emits created and reparented events with effectivePolicy snapshots', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const epicA = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'epic',
          status: 'Draft',
          title: 'Epic A',
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const storyA = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'story',
          status: 'Draft',
          title: 'Story A',
          parentId: epicA,
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const epicB = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'epic',
          status: 'Draft',
          title: 'Epic B',
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const storyB = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'story',
          status: 'Draft',
          title: 'Story B',
          parentId: epicB,
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const repositoryPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: null,
          payload: {
            allowedProviders: ['codex'],
          },
        })
        .run().lastInsertRowid,
    );
    const epicAPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicA,
          payload: {
            budgets: {
              maxConcurrentTasks: 2,
            },
          },
        })
        .run().lastInsertRowid,
    );
    const epicBPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicB,
          payload: {
            budgets: {
              maxConcurrentTasks: 4,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const created = await service.createWorkItem({
      repositoryId: repository.id,
      type: 'task',
      status: 'Draft',
      title: 'Task under story A',
      parentId: storyA,
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(created.workItem.effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicA,
      repositoryPolicyId,
      epicPolicyId: epicAPolicyId,
    });

    const reparented = await service.setWorkItemParent({
      repositoryId: repository.id,
      workItemId: created.workItem.id,
      parentId: storyB,
      expectedRevision: created.workItem.revision,
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(reparented.workItem.effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicB,
      repositoryPolicyId,
      epicPolicyId: epicBPolicyId,
    });

    const taskEvents = db
      .select()
      .from(workItemEvents)
      .where(and(eq(workItemEvents.repositoryId, repository.id), eq(workItemEvents.workItemId, created.workItem.id)))
      .all();

    const createdEvent = taskEvents.find(event => event.eventType === 'created');
    const reparentedEvent = taskEvents.find(event => event.eventType === 'reparented');
    expect(createdEvent).toBeDefined();
    expect(reparentedEvent).toBeDefined();

    expect((createdEvent!.payload as { effectivePolicy?: unknown }).effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicA,
      repositoryPolicyId,
      epicPolicyId: epicAPolicyId,
    });
    expect((reparentedEvent!.payload as { effectivePolicy?: unknown }).effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicB,
      repositoryPolicyId,
      epicPolicyId: epicBPolicyId,
    });
  });

  it('emits descendant task reparented events with refreshed effectivePolicy when moving an ancestor', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const epicA = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'epic',
          status: 'Draft',
          title: 'Epic A',
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const feature = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'feature',
          status: 'Draft',
          title: 'Feature',
          parentId: epicA,
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const story = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'story',
          status: 'Draft',
          title: 'Story',
          parentId: feature,
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const task = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Draft',
          title: 'Task',
          parentId: story,
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const epicB = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'epic',
          status: 'Draft',
          title: 'Epic B',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const repositoryPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: null,
          payload: {
            allowedProviders: ['codex'],
          },
        })
        .run().lastInsertRowid,
    );

    const epicAPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicA,
          payload: {
            budgets: {
              maxConcurrentTasks: 2,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const epicBPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicB,
          payload: {
            budgets: {
              maxConcurrentTasks: 5,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const reparentedFeature = await service.setWorkItemParent({
      repositoryId: repository.id,
      workItemId: feature,
      parentId: epicB,
      expectedRevision: 0,
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(reparentedFeature.workItem.parentId).toBe(epicB);
    expect(reparentedFeature.workItem.effectivePolicy).toBeNull();

    const taskSnapshot = await service.getWorkItem({
      repositoryId: repository.id,
      workItemId: task,
    });
    expect(taskSnapshot.workItem.effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicB,
      repositoryPolicyId,
      epicPolicyId: epicBPolicyId,
    });

    const taskReparentedEvents = db
      .select()
      .from(workItemEvents)
      .where(
        and(
          eq(workItemEvents.repositoryId, repository.id),
          eq(workItemEvents.workItemId, task),
          eq(workItemEvents.eventType, 'reparented'),
        ),
      )
      .all();

    expect(taskReparentedEvents).toHaveLength(1);

    const taskReparentedPayload = taskReparentedEvents[0]!.payload as {
      toParentId?: unknown;
      revision?: unknown;
      expectedRevision?: unknown;
      effectivePolicy?: unknown;
      reason?: unknown;
      ancestorWorkItemId?: unknown;
    };

    expect(taskReparentedPayload.toParentId).toBe(story);
    expect(taskReparentedPayload.revision).toBe(0);
    expect(taskReparentedPayload.expectedRevision).toBe(0);
    expect(taskReparentedPayload.reason).toBe('ancestor_reparent');
    expect(taskReparentedPayload.ancestorWorkItemId).toBe(feature);
    expect(taskReparentedPayload.effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicB,
      repositoryPolicyId,
      epicPolicyId: epicBPolicyId,
    });

    expect(epicAPolicyId).not.toBe(epicBPolicyId);
  });

  it('does not emit descendant task reparented events when ancestor move keeps epic context', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const epicA = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'epic',
          status: 'Draft',
          title: 'Epic A',
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const featureA = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'feature',
          status: 'Draft',
          title: 'Feature A',
          parentId: epicA,
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const featureB = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'feature',
          status: 'Draft',
          title: 'Feature B',
          parentId: epicA,
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const story = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'story',
          status: 'Draft',
          title: 'Story',
          parentId: featureA,
          revision: 0,
        })
        .run().lastInsertRowid,
    );
    const task = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Draft',
          title: 'Task',
          parentId: story,
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const repositoryPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: null,
          payload: {
            allowedProviders: ['codex'],
          },
        })
        .run().lastInsertRowid,
    );

    const epicAPolicyId = Number(
      db.insert(workItemPolicies)
        .values({
          repositoryId: repository.id,
          epicWorkItemId: epicA,
          payload: {
            budgets: {
              maxConcurrentTasks: 2,
            },
          },
        })
        .run().lastInsertRowid,
    );

    const firstReparentedStory = await service.setWorkItemParent({
      repositoryId: repository.id,
      workItemId: story,
      parentId: featureB,
      expectedRevision: 0,
      actorType: 'human',
      actorLabel: 'alice',
    });
    expect(firstReparentedStory.workItem.parentId).toBe(featureB);

    const secondReparentedStory = await service.setWorkItemParent({
      repositoryId: repository.id,
      workItemId: story,
      parentId: featureB,
      expectedRevision: 1,
      actorType: 'human',
      actorLabel: 'alice',
    });
    expect(secondReparentedStory.workItem.parentId).toBe(featureB);

    const taskSnapshot = await service.getWorkItem({
      repositoryId: repository.id,
      workItemId: task,
    });
    expect(taskSnapshot.workItem.effectivePolicy).toMatchObject({
      appliesToType: 'task',
      epicWorkItemId: epicA,
      repositoryPolicyId,
      epicPolicyId: epicAPolicyId,
    });

    const taskReparentedEvents = db
      .select()
      .from(workItemEvents)
      .where(
        and(
          eq(workItemEvents.repositoryId, repository.id),
          eq(workItemEvents.workItemId, task),
          eq(workItemEvents.eventType, 'reparented'),
        ),
      )
      .all();

    expect(taskReparentedEvents).toHaveLength(0);
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
