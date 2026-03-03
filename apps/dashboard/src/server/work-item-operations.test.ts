import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  and,
  createDatabase,
  desc,
  eq,
  insertRepository,
  migrateDatabase,
  workItemEvents,
  workItemPolicies,
  workItemWorkflowRuns,
  workItems,
  runWorktrees,
  workflowRuns,
  workflowTrees,
  treeNodes,
  type AlphredDatabase,
} from '@alphred/db';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner } from '@alphred/core';
import { createDashboardService, type DashboardServiceDependencies } from './dashboard-service';
import { DashboardIntegrationError } from './dashboard-errors';

const execFileAsync = promisify(execFile);

async function runGit(worktreePath: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', worktreePath, ...args], {
    env: process.env,
  });
}

function createHarness(options: {
  dependencies?: Partial<DashboardServiceDependencies>;
  environment?: NodeJS.ProcessEnv;
} = {}): {
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
    ...(options.dependencies ?? {}),
  };

  return {
    db,
    service: createDashboardService({ dependencies, environment: options.environment }),
  };
}

function seedPublishedWorkflowTree(
  db: AlphredDatabase,
  params: {
    treeKey?: string;
    provider?: 'codex' | 'claude';
    model?: string;
  } = {},
): number {
  const treeId = Number(
    db
      .insert(workflowTrees)
      .values({
        treeKey: params.treeKey ?? 'design-implement-review',
        version: 1,
        status: 'published',
        name: 'Autolaunch Tree',
        createdAt: '2026-03-03T00:00:00.000Z',
        updatedAt: '2026-03-03T00:00:00.000Z',
      })
      .run().lastInsertRowid,
  );

  db.insert(treeNodes)
    .values({
      workflowTreeId: treeId,
      nodeKey: 'design',
      nodeType: 'agent',
      provider: params.provider ?? 'codex',
      model: params.model ?? 'gpt-5.3-codex',
      promptTemplateId: null,
      maxRetries: 0,
      sequenceIndex: 0,
      createdAt: '2026-03-03T00:00:00.000Z',
      updatedAt: '2026-03-03T00:00:00.000Z',
    })
    .run();

  return treeId;
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

  it('normalizes plannedFiles to repo-relative paths and rejects invalid paths', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const created = await service.createWorkItem({
      repositoryId: repository.id,
      type: 'task',
      status: 'Draft',
      title: 'Normalize files',
      plannedFiles: ['./src/a.ts', 'src\\\\b.ts', 'src/a.ts'],
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(created.workItem.plannedFiles).toEqual(['src/a.ts', 'src/b.ts']);

    expect(() =>
      service.createWorkItem({
        repositoryId: repository.id,
        type: 'task',
        status: 'Draft',
        title: 'Invalid files',
        plannedFiles: ['/etc/passwd'],
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'invalid_request',
        status: 400,
        message: 'plannedFiles must be an array of repo-relative file paths when provided.',
      }),
    );
  });

  it('links a workflow run when moving a task from Ready to InProgress with linkedWorkflowRunId', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const treeId = seedPublishedWorkflowTree(db);
    const workflowRunId = Number(
      db.insert(workflowRuns)
        .values({
          workflowTreeId: treeId,
          status: 'running',
          startedAt: '2026-03-03T00:01:00.000Z',
          completedAt: null,
          createdAt: '2026-03-03T00:01:00.000Z',
          updatedAt: '2026-03-03T00:01:00.000Z',
        })
        .run().lastInsertRowid,
    );

    const taskId = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Ready',
          title: 'Implement issue',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const moved = await service.moveWorkItemStatus({
      repositoryId: repository.id,
      workItemId: taskId,
      expectedRevision: 0,
      toStatus: 'InProgress',
      actorType: 'human',
      actorLabel: 'alice',
      linkedWorkflowRunId: workflowRunId,
    });

    expect(moved.workItem.status).toBe('InProgress');
    expect(moved.workItem.linkedWorkflowRun).toEqual({
      workflowRunId,
      runStatus: 'running',
      linkedAt: moved.workItem.linkedWorkflowRun?.linkedAt,
    });

    const linkedRow = db
      .select()
      .from(workItemWorkflowRuns)
      .where(and(eq(workItemWorkflowRuns.repositoryId, repository.id), eq(workItemWorkflowRuns.workItemId, taskId)))
      .get();
    expect(linkedRow?.workflowRunId).toBe(workflowRunId);

    const statusEvent = db
      .select()
      .from(workItemEvents)
      .where(
        and(
          eq(workItemEvents.repositoryId, repository.id),
          eq(workItemEvents.workItemId, taskId),
          eq(workItemEvents.eventType, 'status_changed'),
        ),
      )
      .orderBy(desc(workItemEvents.id))
      .limit(1)
      .get();
    expect(statusEvent).not.toBeUndefined();
    const statusPayload = statusEvent?.payload as { linkedWorkflowRun?: { workflowRunId?: number } | null };
    expect(statusPayload.linkedWorkflowRun?.workflowRunId).toBe(workflowRunId);
  });

  it('returns linked run touchedFiles in move status responses', async () => {
    const { db, service } = createHarness();
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-work-item-move-touched-files-'));
    const worktreePath = join(tempRoot, 'repo');

    try {
      await mkdir(worktreePath);
      await runGit(worktreePath, ['init']);
      await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
      await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);
      await mkdir(join(worktreePath, 'src'));
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 1;\n');
      await runGit(worktreePath, ['add', '.']);
      await runGit(worktreePath, ['commit', '-m', 'seed']);
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 2;\n');
      await writeFile(join(worktreePath, 'src', 'c.ts'), 'export const c = true;\n');

      const repository = insertRepository(db, {
        name: 'repo',
        provider: 'github',
        remoteUrl: 'https://example.com/repo.git',
        remoteRef: 'acme/repo',
      });

      const treeId = seedPublishedWorkflowTree(db);
      const workflowRunId = Number(
        db.insert(workflowRuns)
          .values({
            workflowTreeId: treeId,
            status: 'running',
            startedAt: '2026-03-03T00:01:00.000Z',
            completedAt: null,
            createdAt: '2026-03-03T00:01:00.000Z',
            updatedAt: '2026-03-03T00:01:00.000Z',
          })
          .run().lastInsertRowid,
      );

      db.insert(runWorktrees)
        .values({
          repositoryId: repository.id,
          workflowRunId,
          worktreePath,
          branch: 'main',
          status: 'active',
          commitHash: null,
          createdAt: '2026-03-03T00:02:00.000Z',
          removedAt: null,
        })
        .run();

      const taskId = Number(
        db.insert(workItems)
          .values({
            repositoryId: repository.id,
            type: 'task',
            status: 'Ready',
            title: 'Implement issue',
            revision: 0,
          })
          .run().lastInsertRowid,
      );

      const moved = await service.moveWorkItemStatus({
        repositoryId: repository.id,
        workItemId: taskId,
        expectedRevision: 0,
        toStatus: 'InProgress',
        actorType: 'human',
        actorLabel: 'alice',
        linkedWorkflowRunId: workflowRunId,
      });

      expect(moved.workItem.linkedWorkflowRun).toMatchObject({
        workflowRunId,
        runStatus: 'running',
        touchedFiles: ['src/a.ts', 'src/c.ts'],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('derives linked run touchedFiles from run worktree git status output', async () => {
    const { db, service } = createHarness();
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-work-item-touched-files-'));
    const worktreePath = join(tempRoot, 'repo');

    try {
      await mkdir(worktreePath);
      await runGit(worktreePath, ['init']);
      await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
      await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);
      await mkdir(join(worktreePath, 'src'));
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 1;\n');
      await runGit(worktreePath, ['add', '.']);
      await runGit(worktreePath, ['commit', '-m', 'seed']);
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 2;\n');
      await writeFile(join(worktreePath, 'src', 'c.ts'), 'export const c = true;\n');

      const repository = insertRepository(db, {
        name: 'repo',
        provider: 'github',
        remoteUrl: 'https://example.com/repo.git',
        remoteRef: 'acme/repo',
      });

      const treeId = seedPublishedWorkflowTree(db);
      const workflowRunId = Number(
        db.insert(workflowRuns)
          .values({
            workflowTreeId: treeId,
            status: 'running',
            startedAt: '2026-03-03T00:01:00.000Z',
            completedAt: null,
            createdAt: '2026-03-03T00:01:00.000Z',
            updatedAt: '2026-03-03T00:01:00.000Z',
          })
          .run().lastInsertRowid,
      );

      const taskId = Number(
        db.insert(workItems)
          .values({
            repositoryId: repository.id,
            type: 'task',
            status: 'InProgress',
            title: 'Implement issue',
            revision: 0,
            plannedFiles: ['src/a.ts', 'src/b.ts'],
          })
          .run().lastInsertRowid,
      );

      db.insert(workItemWorkflowRuns)
        .values({
          repositoryId: repository.id,
          workItemId: taskId,
          workflowRunId,
          linkedAt: '2026-03-03T00:02:00.000Z',
        })
        .run();

      db.insert(runWorktrees)
        .values({
          repositoryId: repository.id,
          workflowRunId,
          worktreePath,
          branch: 'main',
          status: 'active',
          commitHash: null,
          createdAt: '2026-03-03T00:02:00.000Z',
          removedAt: null,
        })
        .run();

      const workItemResult = await service.getWorkItem({
        repositoryId: repository.id,
        workItemId: taskId,
      });

      expect(workItemResult.workItem.linkedWorkflowRun).toMatchObject({
        workflowRunId,
        runStatus: 'running',
        touchedFiles: ['src/a.ts', 'src/c.ts'],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips touched-file git status reads for removed run worktrees', async () => {
    const { db, service } = createHarness();
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-work-item-removed-worktree-'));
    const worktreePath = join(tempRoot, 'repo');
    try {
      await mkdir(worktreePath);
      await runGit(worktreePath, ['init']);
      await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
      await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);
      await mkdir(join(worktreePath, 'src'));
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 1;\n');
      await runGit(worktreePath, ['add', '.']);
      await runGit(worktreePath, ['commit', '-m', 'seed']);
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 2;\n');

      const repository = insertRepository(db, {
        name: 'repo',
        provider: 'github',
        remoteUrl: 'https://example.com/repo.git',
        remoteRef: 'acme/repo',
      });

      const treeId = seedPublishedWorkflowTree(db);
      const workflowRunId = Number(
        db.insert(workflowRuns)
          .values({
            workflowTreeId: treeId,
            status: 'running',
            startedAt: '2026-03-03T00:01:00.000Z',
            completedAt: null,
            createdAt: '2026-03-03T00:01:00.000Z',
            updatedAt: '2026-03-03T00:01:00.000Z',
          })
          .run().lastInsertRowid,
      );

      const taskId = Number(
        db.insert(workItems)
          .values({
            repositoryId: repository.id,
            type: 'task',
            status: 'InProgress',
            title: 'Implement issue',
            revision: 0,
          })
          .run().lastInsertRowid,
      );

      db.insert(workItemWorkflowRuns)
        .values({
          repositoryId: repository.id,
          workItemId: taskId,
          workflowRunId,
          linkedAt: '2026-03-03T00:02:00.000Z',
        })
        .run();

      db.insert(runWorktrees)
        .values({
          repositoryId: repository.id,
          workflowRunId,
          worktreePath,
          branch: 'main',
          status: 'removed',
          commitHash: null,
          createdAt: '2026-03-03T00:02:00.000Z',
          removedAt: '2026-03-03T00:03:00.000Z',
        })
        .run();

      const workItemResult = await service.getWorkItem({
        repositoryId: repository.id,
        workItemId: taskId,
      });

      expect(workItemResult.workItem.linkedWorkflowRun).toMatchObject({
        workflowRunId,
        runStatus: 'running',
      });
      expect(workItemResult.workItem.linkedWorkflowRun).not.toHaveProperty('touchedFiles');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('requests replanning by appending an audit event with plan-vs-actual deltas', async () => {
    const { db, service } = createHarness();
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-work-item-replan-'));
    const worktreePath = join(tempRoot, 'repo');

    try {
      await mkdir(worktreePath);
      await runGit(worktreePath, ['init']);
      await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
      await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);
      await mkdir(join(worktreePath, 'src'));
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 1;\n');
      await runGit(worktreePath, ['add', '.']);
      await runGit(worktreePath, ['commit', '-m', 'seed']);
      await writeFile(join(worktreePath, 'src', 'a.ts'), 'export const value = 2;\n');
      await writeFile(join(worktreePath, 'src', 'c.ts'), 'export const c = true;\n');

      const repository = insertRepository(db, {
        name: 'repo',
        provider: 'github',
        remoteUrl: 'https://example.com/repo.git',
        remoteRef: 'acme/repo',
      });

      const treeId = seedPublishedWorkflowTree(db);
      const workflowRunId = Number(
        db.insert(workflowRuns)
          .values({
            workflowTreeId: treeId,
            status: 'running',
            startedAt: '2026-03-03T00:01:00.000Z',
            completedAt: null,
            createdAt: '2026-03-03T00:01:00.000Z',
            updatedAt: '2026-03-03T00:01:00.000Z',
          })
          .run().lastInsertRowid,
      );

      const taskId = Number(
        db.insert(workItems)
          .values({
            repositoryId: repository.id,
            type: 'task',
            status: 'InProgress',
            title: 'Implement issue',
            revision: 2,
            plannedFiles: ['src/a.ts', 'src/b.ts'],
          })
          .run().lastInsertRowid,
      );

      db.insert(workItemWorkflowRuns)
        .values({
          repositoryId: repository.id,
          workItemId: taskId,
          workflowRunId,
          linkedAt: '2026-03-03T00:02:00.000Z',
        })
        .run();

      db.insert(runWorktrees)
        .values({
          repositoryId: repository.id,
          workflowRunId,
          worktreePath,
          branch: 'main',
          status: 'active',
          commitHash: null,
          createdAt: '2026-03-03T00:02:00.000Z',
          removedAt: null,
        })
        .run();

      const result = await service.requestWorkItemReplan({
        repositoryId: repository.id,
        workItemId: taskId,
        actorType: 'human',
        actorLabel: 'alice',
      });

      expect(result.repositoryId).toBe(repository.id);
      expect(result.workItemId).toBe(taskId);
      expect(result.workflowRunId).toBe(workflowRunId);
      expect(result.plannedButUntouched).toEqual(['src/b.ts']);
      expect(result.touchedButUnplanned).toEqual(['src/c.ts']);

      const event = db
        .select()
        .from(workItemEvents)
        .where(and(eq(workItemEvents.repositoryId, repository.id), eq(workItemEvents.id, result.eventId)))
        .get();
      expect(event?.eventType).toBe('updated');
      expect(event?.payload).toMatchObject({
        expectedRevision: 2,
        revision: 2,
        replanRequest: {
          workflowRunId,
          plannedButUntouched: ['src/b.ts'],
          touchedButUnplanned: ['src/c.ts'],
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns not_found for requestWorkItemReplan when the work item does not exist', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    await expect(
      service.requestWorkItemReplan({
        repositoryId: repository.id,
        workItemId: 999,
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'Work item id=999 was not found.',
    });
  });

  it('returns invalid_request for requestWorkItemReplan when the target is not a task', async () => {
    const { db, service } = createHarness();

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    const storyId = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'story',
          status: 'Draft',
          title: 'Story item',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    await expect(
      service.requestWorkItemReplan({
        repositoryId: repository.id,
        workItemId: storyId,
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: `Work item id=${storyId} is not a task.`,
    });
  });

  it('auto-launches and links a run when task transitions Ready -> InProgress and autolaunch is enabled', async () => {
    const { db, service } = createHarness({
      environment: {
        ...process.env,
        ALPHRED_DASHBOARD_TASK_RUN_AUTOLAUNCH: '1',
        ALPHRED_DASHBOARD_TASK_RUN_TREE_KEY: 'design-implement-review',
      },
    });

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    seedPublishedWorkflowTree(db, { treeKey: 'design-implement-review', provider: 'codex' });

    const taskId = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Ready',
          title: 'Autolaunch me',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    const moved = await service.moveWorkItemStatus({
      repositoryId: repository.id,
      workItemId: taskId,
      expectedRevision: 0,
      toStatus: 'InProgress',
      actorType: 'human',
      actorLabel: 'alice',
    });

    expect(moved.workItem.status).toBe('InProgress');
    expect(moved.workItem.linkedWorkflowRun?.workflowRunId).toBeGreaterThan(0);

    const linkedRows = db
      .select()
      .from(workItemWorkflowRuns)
      .where(and(eq(workItemWorkflowRuns.repositoryId, repository.id), eq(workItemWorkflowRuns.workItemId, taskId)))
      .all();
    expect(linkedRows).toHaveLength(1);

    const event = db
      .select()
      .from(workItemEvents)
      .where(
        and(
          eq(workItemEvents.repositoryId, repository.id),
          eq(workItemEvents.workItemId, taskId),
          eq(workItemEvents.eventType, 'status_changed'),
        ),
      )
      .orderBy(desc(workItemEvents.id))
      .limit(1)
      .get();
    const eventPayload = event?.payload as { linkedWorkflowRun?: { workflowRunId?: number } | null };
    expect(eventPayload.linkedWorkflowRun?.workflowRunId).toBe(moved.workItem.linkedWorkflowRun?.workflowRunId);
  });

  it('rejects invalid autolaunch move requests before creating workflow runs', async () => {
    const { db, service } = createHarness({
      environment: {
        ...process.env,
        ALPHRED_DASHBOARD_TASK_RUN_AUTOLAUNCH: '1',
        ALPHRED_DASHBOARD_TASK_RUN_TREE_KEY: 'design-implement-review',
      },
    });

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    seedPublishedWorkflowTree(db, { treeKey: 'design-implement-review', provider: 'codex' });

    const taskId = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Ready',
          title: 'Invalid autolaunch request',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    await expect(
      service.moveWorkItemStatus({
        repositoryId: repository.id,
        workItemId: taskId,
        expectedRevision: 0,
        toStatus: 'InProgress',
        actorType: 'human',
        actorLabel: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: 'actorLabel cannot be empty.',
    });

    const persistedTask = db
      .select({
        status: workItems.status,
        revision: workItems.revision,
      })
      .from(workItems)
      .where(and(eq(workItems.repositoryId, repository.id), eq(workItems.id, taskId)))
      .get();
    expect(persistedTask).toEqual({
      status: 'Ready',
      revision: 0,
    });

    const linkedRows = db
      .select()
      .from(workItemWorkflowRuns)
      .where(and(eq(workItemWorkflowRuns.repositoryId, repository.id), eq(workItemWorkflowRuns.workItemId, taskId)))
      .all();
    expect(linkedRows).toHaveLength(0);

    const runRows = db.select().from(workflowRuns).orderBy(desc(workflowRuns.id)).all();
    expect(runRows).toHaveLength(0);
  });

  it('blocks autolaunch when policy provider allowlist rejects workflow node providers', async () => {
    const { db, service } = createHarness({
      environment: {
        ...process.env,
        ALPHRED_DASHBOARD_TASK_RUN_AUTOLAUNCH: '1',
        ALPHRED_DASHBOARD_TASK_RUN_TREE_KEY: 'design-implement-review',
      },
    });

    const repository = insertRepository(db, {
      name: 'repo',
      provider: 'github',
      remoteUrl: 'https://example.com/repo.git',
      remoteRef: 'acme/repo',
    });

    seedPublishedWorkflowTree(db, { treeKey: 'design-implement-review', provider: 'codex' });

    db.insert(workItemPolicies)
      .values({
        repositoryId: repository.id,
        epicWorkItemId: null,
        payload: {
          allowedProviders: ['claude'],
          allowedModels: null,
          allowedSkillIdentifiers: null,
          allowedMcpServerIdentifiers: null,
        },
      })
      .run();

    const taskId = Number(
      db.insert(workItems)
        .values({
          repositoryId: repository.id,
          type: 'task',
          status: 'Ready',
          title: 'Policy-gated task',
          revision: 0,
        })
        .run().lastInsertRowid,
    );

    await expect(
      service.moveWorkItemStatus({
        repositoryId: repository.id,
        workItemId: taskId,
        expectedRevision: 0,
        toStatus: 'InProgress',
        actorType: 'human',
        actorLabel: 'alice',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });

    const taskRow = db
      .select()
      .from(workItems)
      .where(and(eq(workItems.repositoryId, repository.id), eq(workItems.id, taskId)))
      .get();
    expect(taskRow?.status).toBe('Ready');
    expect(taskRow?.revision).toBe(0);

    const linkedRows = db
      .select()
      .from(workItemWorkflowRuns)
      .where(and(eq(workItemWorkflowRuns.repositoryId, repository.id), eq(workItemWorkflowRuns.workItemId, taskId)))
      .all();
    expect(linkedRows).toHaveLength(0);

    const runRows = db.select().from(workflowRuns).orderBy(desc(workflowRuns.id)).all();
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe('cancelled');
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
