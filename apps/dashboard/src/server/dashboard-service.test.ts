import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowRunControlError,
  WorkflowRunExecutionValidationError,
  createSqlWorkflowExecutor,
  createSqlWorkflowPlanner,
} from '@alphred/core';
import { and, eq } from 'drizzle-orm';
import {
  createDatabase,
  migrateDatabase,
  phaseArtifacts,
  promptTemplates,
  repositories,
  runNodeDiagnostics,
  runJoinBarriers,
  runNodeStreamEvents,
  routingDecisions,
  runNodes,
  runWorktrees,
  treeNodes,
  transitionWorkflowRunStatus,
  transitionRunNodeStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import type { AuthStatus, ProviderExecutionPermissions, RepositoryConfig } from '@alphred/shared';
import { createDashboardService, type DashboardServiceDependencies } from './dashboard-service';

function createHarness(overrides: Partial<DashboardServiceDependencies> = {}): {
  db: AlphredDatabase;
  dependencies: DashboardServiceDependencies;
} {
  const db = createDatabase(':memory:');

  const dependencies: DashboardServiceDependencies = {
    openDatabase: () => db,
    migrateDatabase: input => migrateDatabase(input),
    closeDatabase: () => undefined,
    resolveProvider: () => {
      throw new Error('resolveProvider should not be called in this test');
    },
    createScmProvider: () => ({
      checkAuth: async () => ({
        authenticated: true,
        user: 'tester',
        scopes: ['repo'],
      } satisfies AuthStatus),
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
    ...overrides,
  };

  return {
    db,
    dependencies,
  };
}

function seedRunData(db: AlphredDatabase): void {
  migrateDatabase(db);

  const treeId = Number(
    db
      .insert(workflowTrees)
      .values({
        treeKey: 'demo-tree',
        version: 1,
        name: 'Demo Tree',
        description: 'Demo tree description',
        createdAt: '2026-02-17T20:00:00.000Z',
        updatedAt: '2026-02-17T20:00:00.000Z',
      })
      .run().lastInsertRowid,
  );

  const repositoryId = Number(
    db
      .insert(repositories)
      .values({
        name: 'demo-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/repos/demo-repo',
        cloneStatus: 'cloned',
        createdAt: '2026-02-17T20:00:00.000Z',
        updatedAt: '2026-02-17T20:00:00.000Z',
      })
      .run().lastInsertRowid,
  );

  const treeNodeId = Number(
    db
      .insert(treeNodes)
      .values({
        workflowTreeId: treeId,
        nodeKey: 'design',
        nodeType: 'agent',
        provider: 'codex',
            model: 'gpt-5.3-codex',
        promptTemplateId: null,
        maxRetries: 0,
        sequenceIndex: 0,
        createdAt: '2026-02-17T20:00:00.000Z',
        updatedAt: '2026-02-17T20:00:00.000Z',
      })
      .run().lastInsertRowid,
  );

  const runId = Number(
    db
      .insert(workflowRuns)
      .values({
        workflowTreeId: treeId,
        status: 'completed',
        startedAt: '2026-02-17T20:01:00.000Z',
        completedAt: '2026-02-17T20:02:00.000Z',
        createdAt: '2026-02-17T20:01:00.000Z',
        updatedAt: '2026-02-17T20:02:00.000Z',
      })
      .run().lastInsertRowid,
  );

  const runNodeId = Number(
    db
      .insert(runNodes)
      .values({
        workflowRunId: runId,
        treeNodeId,
        nodeKey: 'design',
        status: 'pending',
        sequenceIndex: 0,
        attempt: 1,
        startedAt: null,
        completedAt: null,
        createdAt: '2026-02-17T20:01:00.000Z',
        updatedAt: '2026-02-17T20:02:00.000Z',
      })
      .run().lastInsertRowid,
  );

  transitionRunNodeStatus(db, {
    runNodeId,
    expectedFrom: 'pending',
    to: 'running',
    occurredAt: '2026-02-17T20:01:00.000Z',
  });
  transitionRunNodeStatus(db, {
    runNodeId,
    expectedFrom: 'running',
    to: 'completed',
    occurredAt: '2026-02-17T20:02:00.000Z',
  });

  db.insert(phaseArtifacts)
    .values({
      workflowRunId: runId,
      runNodeId,
      artifactType: 'report',
      contentType: 'markdown',
      content: 'Agent finished successfully with actionable notes.',
      metadata: null,
      createdAt: '2026-02-17T20:02:00.000Z',
    })
    .run();

  db.insert(routingDecisions)
    .values({
      workflowRunId: runId,
      runNodeId,
      decisionType: 'approved',
      rationale: 'Quality checks passed.',
      rawOutput: null,
      createdAt: '2026-02-17T20:02:01.000Z',
    })
    .run();

  db.insert(runNodeDiagnostics)
    .values({
      workflowRunId: runId,
      runNodeId,
      attempt: 1,
      outcome: 'completed',
      eventCount: 3,
      retainedEventCount: 3,
      droppedEventCount: 0,
      redacted: 0,
      truncated: 0,
      payloadChars: 512,
      diagnostics: {
        schemaVersion: 1,
        workflowRunId: runId,
        runNodeId,
        nodeKey: 'design',
        attempt: 1,
        outcome: 'completed',
        status: 'completed',
        provider: 'codex',
        timing: {
          queuedAt: '2026-02-17T20:01:00.000Z',
          startedAt: '2026-02-17T20:01:00.000Z',
          completedAt: '2026-02-17T20:02:00.000Z',
          failedAt: null,
          persistedAt: '2026-02-17T20:02:02.000Z',
        },
        summary: {
          tokensUsed: 42,
          inputTokens: 24,
          outputTokens: 18,
          cachedInputTokens: 5,
          eventCount: 3,
          retainedEventCount: 3,
          droppedEventCount: 0,
          toolEventCount: 0,
          redacted: false,
          truncated: false,
        },
        contextHandoff: {},
        eventTypeCounts: {
          system: 1,
          result: 1,
        },
        events: [],
        toolEvents: [],
        routingDecision: 'approved',
        error: null,
      },
      createdAt: '2026-02-17T20:02:02.000Z',
    })
    .run();

  db.insert(runNodeStreamEvents)
    .values([
      {
        workflowRunId: runId,
        runNodeId,
        attempt: 1,
        sequence: 1,
        eventType: 'system',
        timestamp: 100,
        contentChars: 7,
        contentPreview: 'starting',
        metadata: { channel: 'provider' },
        usageDeltaTokens: null,
        usageCumulativeTokens: null,
        createdAt: '2026-02-17T20:01:30.000Z',
      },
      {
        workflowRunId: runId,
        runNodeId,
        attempt: 1,
        sequence: 2,
        eventType: 'result',
        timestamp: 101,
        contentChars: 12,
        contentPreview: 'done output',
        metadata: null,
        usageDeltaTokens: null,
        usageCumulativeTokens: null,
        createdAt: '2026-02-17T20:02:00.000Z',
      },
    ])
    .run();

  db.insert(runWorktrees)
    .values({
      workflowRunId: runId,
      repositoryId,
      worktreePath: '/tmp/worktrees/demo-run-1',
      branch: 'alphred/demo-tree/1',
      commitHash: 'abc1234',
      status: 'active',
      createdAt: '2026-02-17T20:01:10.000Z',
      removedAt: null,
    })
    .run();
}

async function waitForBackgroundExecution(service: ReturnType<typeof createDashboardService>, workflowRunId: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && service.hasBackgroundExecution(workflowRunId)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function createDatabaseWithWorkflowTreeInsertUniqueRace(db: AlphredDatabase): {
  proxiedDatabase: AlphredDatabase;
  wasInjected: () => boolean;
} {
  let injectedUniqueRace = false;
  const originalTransaction = db.transaction.bind(db);

  const proxiedDatabase = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return ((callback: (tx: unknown) => unknown) =>
          originalTransaction((tx) => {
            const originalInsert = tx.insert.bind(tx);
            const txProxy = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === 'insert') {
                  return ((table: unknown) => {
                    if (table !== workflowTrees || injectedUniqueRace) {
                      return originalInsert(table as never);
                    }

                    return {
                      values: () => ({
                        returning: () => ({
                          get: () => {
                            injectedUniqueRace = true;
                            const error = new Error('UNIQUE constraint failed: workflow_trees.tree_key');
                            (error as { code?: string }).code = 'SQLITE_CONSTRAINT_UNIQUE';
                            throw error;
                          },
                        }),
                      }),
                    } as unknown as ReturnType<typeof originalInsert>;
                  }) as AlphredDatabase['insert'];
                }

                const value = Reflect.get(txTarget, txProp, txReceiver);
                return typeof value === 'function' ? value.bind(txTarget) : value;
              },
            });
            return callback(txProxy);
          })) as unknown as AlphredDatabase['transaction'];
      }

      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    proxiedDatabase,
    wasInjected: () => injectedUniqueRace,
  };
}

describe('createDashboardService', () => {
  it('closes database handles after each operation', async () => {
    const closeDatabase = vi.fn(() => undefined);
    const { db, dependencies } = createHarness({ closeDatabase });
    seedRunData(db);

    const service = createDashboardService({ dependencies });

    await service.listRepositories();
    await service.listWorkflowTrees();

    expect(closeDatabase).toHaveBeenCalledTimes(2);
    expect(closeDatabase).toHaveBeenNthCalledWith(1, db);
    expect(closeDatabase).toHaveBeenNthCalledWith(2, db);
  });

  it('closes database handles when migration fails', async () => {
    const closeDatabase = vi.fn(() => undefined);
    const migrateDatabaseMock = vi.fn(() => {
      throw new Error('migration failed');
    });
    const { db, dependencies } = createHarness({
      migrateDatabase: migrateDatabaseMock,
      closeDatabase,
    });
    const service = createDashboardService({ dependencies });

    await expect(service.listRepositories()).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'internal_error',
      status: 500,
    });

    expect(migrateDatabaseMock).toHaveBeenCalledTimes(1);
    expect(migrateDatabaseMock).toHaveBeenCalledWith(db);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledWith(db);
  });

  it('uses a separate database lifecycle for async run execution', async () => {
    const closeDatabase = vi.fn(() => undefined);
    const executeRun = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });
    const { db, dependencies } = createHarness({
      closeDatabase,
      createSqlWorkflowExecutor: () =>
        ({ executeRun }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.launchWorkflowRun({
      treeKey: 'demo-tree',
      executionMode: 'async',
    });

    expect(result.mode).toBe('async');
    expect(closeDatabase).toHaveBeenCalledTimes(1);

    await waitForBackgroundExecution(service, result.workflowRunId);

    expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(2);
  });

  it('dispatches synchronous single-node launches to executeSingleNode', async () => {
    const executeRun = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'completed',
      },
      executedNodes: 2,
    }));
    const executeSingleNode = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'run_terminal',
      },
      executedNodes: 1,
    }));
    const validateSingleNodeSelection = vi.fn(() => undefined);
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          executeSingleNode,
          validateSingleNodeSelection,
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.launchWorkflowRun({
      treeKey: 'demo-tree',
      executionMode: 'sync',
      executionScope: 'single_node',
      nodeSelector: {
        type: 'node_key',
        nodeKey: 'design',
      },
    });

    expect(result.mode).toBe('sync');
    expect(executeSingleNode).toHaveBeenCalledTimes(1);
    expect(executeSingleNode).toHaveBeenCalledWith({
      workflowRunId: result.workflowRunId,
      options: {
        workingDirectory: process.cwd(),
      },
      nodeSelector: {
        type: 'node_key',
        nodeKey: 'design',
      },
    });
    expect(executeRun).not.toHaveBeenCalled();
    expect(validateSingleNodeSelection).not.toHaveBeenCalled();
  });

  it('validates selector before enqueuing async single-node launches', async () => {
    const executeRun = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'completed',
      },
      executedNodes: 2,
    }));
    const executeSingleNode = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'run_terminal',
      },
      executedNodes: 1,
    }));
    const validateSingleNodeSelection = vi.fn(() => undefined);
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          executeSingleNode,
          validateSingleNodeSelection,
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.launchWorkflowRun({
      treeKey: 'demo-tree',
      executionMode: 'async',
      executionScope: 'single_node',
      nodeSelector: {
        type: 'next_runnable',
      },
    });

    expect(result.mode).toBe('async');
    expect(validateSingleNodeSelection).toHaveBeenCalledTimes(1);
    expect(validateSingleNodeSelection).toHaveBeenCalledWith({
      workflowRunId: result.workflowRunId,
      nodeSelector: {
        type: 'next_runnable',
      },
    });

    await waitForBackgroundExecution(service, result.workflowRunId);

    expect(executeSingleNode).toHaveBeenCalledTimes(1);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('attempts cleanupWorktree for sync launches when execution fails', async () => {
    const executeRun = vi.fn(async () => {
      throw new Error('executor failed');
    });
    const cleanupRun = vi.fn(async () => undefined);
    const createRunWorktree = vi.fn(async () => ({
      id: 1,
      runId: 1,
      repositoryId: 1,
      path: '/tmp/worktree-failure',
      branch: 'main',
      commitHash: null,
      createdAt: '2026-02-17T20:00:00.000Z',
    }));

    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({ executeRun }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
      createWorktreeManager: () => ({
        createRunWorktree,
        cleanupRun,
      }),
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });

    await expect(
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        repositoryName: 'demo-repo',
        executionMode: 'sync',
        cleanupWorktree: true,
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'internal_error',
      status: 500,
    });

    expect(createRunWorktree).toHaveBeenCalledTimes(1);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(cleanupRun).toHaveBeenCalledTimes(1);
  });

  it('attempts cleanupWorktree for async launches when execution fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeRun = vi.fn(async () => {
      throw new Error('executor failed');
    });
    const cleanupRun = vi.fn(async () => undefined);
    const createRunWorktree = vi.fn(async () => ({
      id: 1,
      runId: 1,
      repositoryId: 1,
      path: '/tmp/worktree-failure',
      branch: 'main',
      commitHash: null,
      createdAt: '2026-02-17T20:00:00.000Z',
    }));
    const createWorktreeManager = vi.fn(() => ({
      createRunWorktree,
      cleanupRun,
    }));

    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({ executeRun }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
      createWorktreeManager,
    });
    seedRunData(db);

    try {
      const service = createDashboardService({ dependencies });
      const result = await service.launchWorkflowRun({
        treeKey: 'demo-tree',
        repositoryName: 'demo-repo',
        executionMode: 'async',
        cleanupWorktree: true,
      });

      expect(result.mode).toBe('async');

      await waitForBackgroundExecution(service, result.workflowRunId);

      expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
      expect(createWorktreeManager).toHaveBeenCalledTimes(2);
      expect(executeRun).toHaveBeenCalledTimes(1);
      expect(cleanupRun).toHaveBeenCalledTimes(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('marks accepted async runs as cancelled when detached startup fails before execution begins', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createRunWorktree = vi.fn(async () => ({
      id: 1,
      runId: 1,
      repositoryId: 1,
      path: '/tmp/worktree-failure',
      branch: 'main',
      commitHash: null,
      createdAt: '2026-02-17T20:00:00.000Z',
    }));
    const cleanupRun = vi.fn(async () => undefined);
    const createWorktreeManager = vi
      .fn()
      .mockImplementationOnce(() => ({
        createRunWorktree,
        cleanupRun,
      }))
      .mockImplementationOnce(() => {
        throw new Error('background worktree manager init failed');
      });

    const { db, dependencies } = createHarness({
      createWorktreeManager,
    });
    seedRunData(db);

    try {
      const service = createDashboardService({ dependencies });
      const result = await service.launchWorkflowRun({
        treeKey: 'demo-tree',
        repositoryName: 'demo-repo',
        executionMode: 'async',
      });

      await waitForBackgroundExecution(service, result.workflowRunId);

      const persisted = db
        .select({
          status: workflowRuns.status,
          startedAt: workflowRuns.startedAt,
          completedAt: workflowRuns.completedAt,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, result.workflowRunId))
        .get();

      expect(persisted?.status).toBe('cancelled');
      expect(persisted?.startedAt).toBeNull();
      expect(persisted?.completedAt).not.toBeNull();
      expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('marks accepted async runs as failed when detached execution fails after the run starts', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun: async (params: { workflowRunId: number }) => {
            transitionWorkflowRunStatus(db, {
              workflowRunId: params.workflowRunId,
              expectedFrom: 'pending',
              to: 'running',
            });
            throw new Error('executor failed after run start');
          },
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);

    try {
      const service = createDashboardService({ dependencies });
      const result = await service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionMode: 'async',
      });

      await waitForBackgroundExecution(service, result.workflowRunId);

      const persisted = db
        .select({
          status: workflowRuns.status,
          startedAt: workflowRuns.startedAt,
          completedAt: workflowRuns.completedAt,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, result.workflowRunId))
        .get();

      expect(persisted?.status).toBe('failed');
      expect(persisted?.startedAt).not.toBeNull();
      expect(persisted?.completedAt).not.toBeNull();
      expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('marks resumed runs as cancelled when detached execution fails after pausing mid-flight', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resumeRun = vi.fn(async () => ({
      action: 'resume' as const,
      outcome: 'applied' as const,
      workflowRunId: 2,
      previousRunStatus: 'paused' as const,
      runStatus: 'running' as const,
      retriedRunNodeIds: [] as number[],
    }));
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun: async (params: { workflowRunId: number }) => {
            transitionWorkflowRunStatus(db, {
              workflowRunId: params.workflowRunId,
              expectedFrom: 'running',
              to: 'paused',
              occurredAt: '2026-02-17T20:03:00.000Z',
            });
            throw new Error('executor interrupted after pause');
          },
          cancelRun: vi.fn(),
          pauseRun: vi.fn(),
          resumeRun,
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);
    const planner = createSqlWorkflowPlanner(db);
    const materialized = planner.materializeRun({ treeKey: 'demo-tree' });

    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T20:01:00.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'running',
      to: 'paused',
      occurredAt: '2026-02-17T20:02:00.000Z',
    });

    try {
      const service = createDashboardService({ dependencies });
      const result = await service.controlWorkflowRun(materialized.run.id, 'resume');
      expect(result).toMatchObject({
        action: 'resume',
        outcome: 'applied',
        workflowRunId: materialized.run.id,
        previousRunStatus: 'paused',
        runStatus: 'running',
      });
      await waitForBackgroundExecution(service, materialized.run.id);

      const persisted = db
        .select({
          status: workflowRuns.status,
        })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, materialized.run.id))
        .get();
      expect(persisted?.status).toBe('cancelled');
      expect(service.hasBackgroundExecution(materialized.run.id)).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('preserves attempt-one telemetry when retry requeues failed nodes', async () => {
    const { db, dependencies } = createHarness({
      resolveProvider: () => ({
        name: 'codex',
        async *run() {
          yield {
            type: 'result' as const,
            content: 'retry-complete',
            timestamp: 1,
          };
        },
      }),
    });
    seedRunData(db);

    const planner = createSqlWorkflowPlanner(db);
    const materialized = planner.materializeRun({ treeKey: 'demo-tree' });
    const runNodeId = materialized.runNodes[0]?.id;
    if (runNodeId === undefined) {
      throw new Error('Expected materialized run to include a node.');
    }

    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T20:10:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T20:10:10.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-02-17T20:10:20.000Z',
    });
    transitionWorkflowRunStatus(db, {
      workflowRunId: materialized.run.id,
      expectedFrom: 'running',
      to: 'failed',
      occurredAt: '2026-02-17T20:10:30.000Z',
    });

    db.insert(runNodeDiagnostics)
      .values({
        workflowRunId: materialized.run.id,
        runNodeId,
        attempt: 1,
        outcome: 'failed',
        eventCount: 2,
        retainedEventCount: 2,
        droppedEventCount: 0,
        redacted: 0,
        truncated: 0,
        payloadChars: 256,
        diagnostics: {
          schemaVersion: 1,
          workflowRunId: materialized.run.id,
          runNodeId,
          nodeKey: 'design',
          attempt: 1,
          outcome: 'failed',
          status: 'failed',
          provider: 'codex',
          timing: {
            queuedAt: '2026-02-17T20:10:00.000Z',
            startedAt: '2026-02-17T20:10:10.000Z',
            completedAt: null,
            failedAt: '2026-02-17T20:10:20.000Z',
            persistedAt: '2026-02-17T20:10:31.000Z',
          },
          summary: {
            tokensUsed: 0,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            eventCount: 2,
            retainedEventCount: 2,
            droppedEventCount: 0,
            toolEventCount: 0,
            redacted: false,
            truncated: false,
          },
          contextHandoff: {},
          eventTypeCounts: {
            system: 1,
            result: 1,
          },
          events: [],
          toolEvents: [],
          routingDecision: null,
          error: {
            code: 'RETRY_FIXTURE_FAILED',
            message: 'first attempt failed',
          },
        },
        createdAt: '2026-02-17T20:10:31.000Z',
      })
      .run();

    db.insert(runNodeStreamEvents)
      .values([
        {
          workflowRunId: materialized.run.id,
          runNodeId,
          attempt: 1,
          sequence: 1,
          eventType: 'system',
          timestamp: 100,
          contentChars: 7,
          contentPreview: 'started',
          metadata: null,
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
          createdAt: '2026-02-17T20:10:10.000Z',
        },
        {
          workflowRunId: materialized.run.id,
          runNodeId,
          attempt: 1,
          sequence: 2,
          eventType: 'result',
          timestamp: 101,
          contentChars: 6,
          contentPreview: 'failed',
          metadata: null,
          usageDeltaTokens: null,
          usageCumulativeTokens: null,
          createdAt: '2026-02-17T20:10:20.000Z',
        },
      ])
      .run();

    const service = createDashboardService({ dependencies });
    const retryResult = await service.controlWorkflowRun(materialized.run.id, 'retry');
    expect(retryResult).toEqual({
      action: 'retry',
      outcome: 'applied',
      workflowRunId: materialized.run.id,
      previousRunStatus: 'failed',
      runStatus: 'running',
      retriedRunNodeIds: [runNodeId],
    });

    await waitForBackgroundExecution(service, materialized.run.id);

    const detail = await service.getWorkflowRunDetail(materialized.run.id);
    expect(detail.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runNodeId,
          attempt: 1,
          outcome: 'failed',
        }),
      ]),
    );

    const streamSnapshot = await service.getRunNodeStreamSnapshot({
      runId: materialized.run.id,
      runNodeId,
      attempt: 1,
    });
    expect(streamSnapshot.attempt).toBe(1);
    expect(streamSnapshot.ended).toBe(true);
    expect(streamSnapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: 1,
          sequence: 1,
        }),
        expect.objectContaining({
          attempt: 1,
          sequence: 2,
        }),
      ]),
    );
  });

  it('loads repository and run snapshots from the shared db schema', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);

    const service = createDashboardService({
      dependencies,
      cwd: '/work/alphred',
    });

    const repositoriesResponse = await service.listRepositories();
    expect(repositoriesResponse).toHaveLength(1);
    expect(repositoriesResponse[0]?.name).toBe('demo-repo');

    const workflowTreesResponse = await service.listWorkflowTrees();
    expect(workflowTreesResponse).toHaveLength(1);
    expect(workflowTreesResponse[0]?.treeKey).toBe('demo-tree');

    const runsResponse = await service.listWorkflowRuns();
    expect(runsResponse).toHaveLength(1);
    expect(runsResponse[0]?.repository).toEqual({
      id: 1,
      name: 'demo-repo',
    });
    expect(runsResponse[0]?.nodeSummary.completed).toBe(1);

    const runDetail = await service.getWorkflowRunDetail(1);
    expect(runDetail.run.id).toBe(1);
    expect(runDetail.nodes).toHaveLength(1);
    expect(runDetail.nodes[0]?.latestArtifact?.artifactType).toBe('report');
    expect(runDetail.nodes[0]?.latestRoutingDecision?.decisionType).toBe('approved');
    expect(runDetail.nodes[0]?.latestDiagnostics?.outcome).toBe('completed');
    expect(runDetail.diagnostics).toHaveLength(1);
    expect(runDetail.worktrees).toHaveLength(1);
  });

  it('retrieves full failed command output by run-node attempt and event index', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const runNode = db
      .select({
        id: runNodes.id,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, 1))
      .get();
    if (!runNode) {
      throw new Error('Expected seeded run node.');
    }

    const fullOutput = `config.webServer failed:\n${'stderr\n'.repeat(800)}`;
    db.insert(phaseArtifacts)
      .values({
        workflowRunId: 1,
        runNodeId: runNode.id,
        artifactType: 'log',
        contentType: 'json',
        content: JSON.stringify({
          schemaVersion: 1,
          workflowRunId: 1,
          runNodeId: runNode.id,
          attempt: 1,
          eventIndex: 2,
          sequence: 3,
          command: 'pnpm test:e2e',
          exitCode: 1,
          output: fullOutput,
          outputChars: fullOutput.length,
          stdout: null,
          stderr: fullOutput,
        }),
        metadata: {
          kind: 'failed_command_output_v1',
          attempt: 1,
          eventIndex: 2,
          sequence: 3,
          command: 'pnpm test:e2e',
          exitCode: 1,
          outputChars: fullOutput.length,
        },
        createdAt: '2026-02-17T20:03:00.000Z',
      })
      .run();

    const service = createDashboardService({
      dependencies,
      cwd: '/work/alphred',
    });

    const output = await service.getRunNodeDiagnosticCommandOutput({
      runId: 1,
      runNodeId: runNode.id,
      attempt: 1,
      eventIndex: 2,
    });

    expect(output).toEqual({
      workflowRunId: 1,
      runNodeId: runNode.id,
      attempt: 1,
      eventIndex: 2,
      sequence: 3,
      artifactId: expect.any(Number),
      command: 'pnpm test:e2e',
      exitCode: 1,
      outputChars: fullOutput.length,
      output: fullOutput,
      stdout: null,
      stderr: fullOutput,
      createdAt: '2026-02-17T20:03:00.000Z',
    });
  });

  it('returns not_found when failed command output is unavailable for an event index', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const runNode = db
      .select({
        id: runNodes.id,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, 1))
      .get();
    if (!runNode) {
      throw new Error('Expected seeded run node.');
    }

    const service = createDashboardService({
      dependencies,
      cwd: '/work/alphred',
    });

    await expect(
      service.getRunNodeDiagnosticCommandOutput({
        runId: 1,
        runNodeId: runNode.id,
        attempt: 1,
        eventIndex: 9,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('scopes fan-out child membership to each barrier batch for the same spawner and join pair', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const treeId = Number(
      db
        .insert(workflowTrees)
        .values({
          treeKey: 'fanout-batch-tree',
          version: 1,
          name: 'Fan-out Batch Tree',
          createdAt: '2026-02-17T21:00:00.000Z',
          updatedAt: '2026-02-17T21:00:00.000Z',
        })
        .run().lastInsertRowid,
    );

    const insertedTreeNodes = db
      .insert(treeNodes)
      .values([
        {
          workflowTreeId: treeId,
          nodeKey: 'spawner',
          nodeRole: 'spawner',
          nodeType: 'agent',
          provider: 'codex',
          promptTemplateId: null,
          sequenceIndex: 10,
          createdAt: '2026-02-17T21:00:00.000Z',
          updatedAt: '2026-02-17T21:00:00.000Z',
        },
        {
          workflowTreeId: treeId,
          nodeKey: 'join',
          nodeRole: 'join',
          nodeType: 'agent',
          provider: 'codex',
          promptTemplateId: null,
          sequenceIndex: 20,
          createdAt: '2026-02-17T21:00:00.000Z',
          updatedAt: '2026-02-17T21:00:00.000Z',
        },
      ])
      .returning({
        id: treeNodes.id,
        nodeKey: treeNodes.nodeKey,
      })
      .all();
    const treeNodeIdByKey = new Map(insertedTreeNodes.map(node => [node.nodeKey, node.id]));
    const spawnerTreeNodeId = treeNodeIdByKey.get('spawner');
    const joinTreeNodeId = treeNodeIdByKey.get('join');
    if (!spawnerTreeNodeId || !joinTreeNodeId) {
      throw new Error('Expected spawner/join tree nodes to exist.');
    }

    const runId = Number(
      db
        .insert(workflowRuns)
        .values({
          workflowTreeId: treeId,
          status: 'running',
          startedAt: '2026-02-17T21:01:00.000Z',
          completedAt: null,
          createdAt: '2026-02-17T21:01:00.000Z',
          updatedAt: '2026-02-17T21:01:00.000Z',
        })
        .run().lastInsertRowid,
    );

    const spawnerRunNodeId = Number(
      db
        .insert(runNodes)
        .values({
          workflowRunId: runId,
          treeNodeId: spawnerTreeNodeId,
          nodeKey: 'spawner',
          nodeRole: 'spawner',
          nodeType: 'agent',
          provider: 'codex',
          status: 'pending',
          sequenceIndex: 10,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-02-17T21:01:00.000Z',
          updatedAt: '2026-02-17T21:01:00.000Z',
        })
        .run().lastInsertRowid,
    );
    const joinRunNodeId = Number(
      db
        .insert(runNodes)
        .values({
          workflowRunId: runId,
          treeNodeId: joinTreeNodeId,
          nodeKey: 'join',
          nodeRole: 'join',
          nodeType: 'agent',
          provider: 'codex',
          status: 'pending',
          sequenceIndex: 20,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-02-17T21:01:00.000Z',
          updatedAt: '2026-02-17T21:01:00.000Z',
        })
        .run().lastInsertRowid,
    );

    const childNodeIds = db
      .insert(runNodes)
      .values([
        {
          workflowRunId: runId,
          treeNodeId: spawnerTreeNodeId,
          nodeKey: 'child-a',
          nodeRole: 'standard',
          nodeType: 'agent',
          provider: 'codex',
          spawnerNodeId: spawnerRunNodeId,
          joinNodeId: joinRunNodeId,
          lineageDepth: 1,
          sequencePath: '10.1',
          status: 'pending',
          sequenceIndex: 30,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-02-17T21:02:00.000Z',
          updatedAt: '2026-02-17T21:02:00.000Z',
        },
        {
          workflowRunId: runId,
          treeNodeId: spawnerTreeNodeId,
          nodeKey: 'child-b',
          nodeRole: 'standard',
          nodeType: 'agent',
          provider: 'codex',
          spawnerNodeId: spawnerRunNodeId,
          joinNodeId: joinRunNodeId,
          lineageDepth: 1,
          sequencePath: '10.2',
          status: 'pending',
          sequenceIndex: 31,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-02-17T21:03:00.000Z',
          updatedAt: '2026-02-17T21:03:00.000Z',
        },
        {
          workflowRunId: runId,
          treeNodeId: spawnerTreeNodeId,
          nodeKey: 'child-c',
          nodeRole: 'standard',
          nodeType: 'agent',
          provider: 'codex',
          spawnerNodeId: spawnerRunNodeId,
          joinNodeId: joinRunNodeId,
          lineageDepth: 1,
          sequencePath: '10.1',
          status: 'pending',
          sequenceIndex: 40,
          attempt: 1,
          startedAt: null,
          completedAt: null,
          createdAt: '2026-02-17T21:04:00.000Z',
          updatedAt: '2026-02-17T21:04:00.000Z',
        },
      ])
      .returning({ id: runNodes.id })
      .all()
      .map(node => node.id);
    const [childAId, childBId, childCId] = childNodeIds;
    if (!childAId || !childBId || !childCId) {
      throw new Error('Expected all fan-out child run nodes to be inserted.');
    }

    transitionRunNodeStatus(db, {
      runNodeId: spawnerRunNodeId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T21:01:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: spawnerRunNodeId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-02-17T21:01:30.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: childAId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T21:02:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: childAId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-02-17T21:02:30.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: childBId,
      expectedFrom: 'pending',
      to: 'running',
      occurredAt: '2026-02-17T21:03:00.000Z',
    });
    transitionRunNodeStatus(db, {
      runNodeId: childBId,
      expectedFrom: 'running',
      to: 'completed',
      occurredAt: '2026-02-17T21:03:30.000Z',
    });

    const spawnArtifactA = Number(
      db
        .insert(phaseArtifacts)
        .values({
          workflowRunId: runId,
          runNodeId: spawnerRunNodeId,
          artifactType: 'report',
          contentType: 'json',
          content: '{"schemaVersion":1,"subtasks":[{"nodeKey":"child-a"},{"nodeKey":"child-b"}]}',
          metadata: null,
          createdAt: '2026-02-17T21:01:30.000Z',
        })
        .run().lastInsertRowid,
    );
    const spawnArtifactB = Number(
      db
        .insert(phaseArtifacts)
        .values({
          workflowRunId: runId,
          runNodeId: spawnerRunNodeId,
          artifactType: 'report',
          contentType: 'json',
          content: '{"schemaVersion":1,"subtasks":[{"nodeKey":"child-c"}]}',
          metadata: null,
          createdAt: '2026-02-17T21:03:45.000Z',
        })
        .run().lastInsertRowid,
    );

    db.insert(runJoinBarriers)
      .values([
        {
          workflowRunId: runId,
          spawnerRunNodeId: spawnerRunNodeId,
          joinRunNodeId: joinRunNodeId,
          spawnSourceArtifactId: spawnArtifactA,
          expectedChildren: 2,
          terminalChildren: 2,
          completedChildren: 2,
          failedChildren: 0,
          status: 'released',
          createdAt: '2026-02-17T21:01:31.000Z',
          updatedAt: '2026-02-17T21:03:31.000Z',
          releasedAt: '2026-02-17T21:03:31.000Z',
        },
        {
          workflowRunId: runId,
          spawnerRunNodeId: spawnerRunNodeId,
          joinRunNodeId: joinRunNodeId,
          spawnSourceArtifactId: spawnArtifactB,
          expectedChildren: 1,
          terminalChildren: 0,
          completedChildren: 0,
          failedChildren: 0,
          status: 'pending',
          createdAt: '2026-02-17T21:03:46.000Z',
          updatedAt: '2026-02-17T21:03:46.000Z',
          releasedAt: null,
        },
      ])
      .run();

    const service = createDashboardService({ dependencies });
    const detail = await service.getWorkflowRunDetail(runId);

    expect(detail.fanOutGroups).toEqual([
      expect.objectContaining({
        spawnerNodeId: spawnerRunNodeId,
        joinNodeId: joinRunNodeId,
        spawnSourceArtifactId: spawnArtifactA,
        expectedChildren: 2,
        childNodeIds: [childAId, childBId],
      }),
      expect.objectContaining({
        spawnerNodeId: spawnerRunNodeId,
        joinNodeId: joinRunNodeId,
        spawnSourceArtifactId: spawnArtifactB,
        expectedChildren: 1,
        childNodeIds: [childCId],
      }),
    ]);
  });

  it('loads run-node stream snapshots with resume semantics and terminal status', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const streamSnapshot = await service.getRunNodeStreamSnapshot({
      runId: 1,
      runNodeId: 1,
      attempt: 1,
      lastEventSequence: 1,
    });

    expect(streamSnapshot.workflowRunId).toBe(1);
    expect(streamSnapshot.runNodeId).toBe(1);
    expect(streamSnapshot.attempt).toBe(1);
    expect(streamSnapshot.latestSequence).toBe(2);
    expect(streamSnapshot.nodeStatus).toBe('completed');
    expect(streamSnapshot.ended).toBe(true);
    expect(streamSnapshot.events).toEqual([
      expect.objectContaining({
        sequence: 2,
        type: 'result',
        contentPreview: 'done output',
      }),
    ]);
  });

  it('rejects stream snapshots for unknown future attempts', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    await expect(
      service.getRunNodeStreamSnapshot({
        runId: 1,
        runNodeId: 1,
        attempt: 2,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('returns null run repository context when no run worktree exists', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    db.delete(runWorktrees).where(eq(runWorktrees.workflowRunId, 1)).run();

    const service = createDashboardService({ dependencies });
    const runsResponse = await service.listWorkflowRuns();

    expect(runsResponse).toHaveLength(1);
    expect(runsResponse[0]?.repository).toBeNull();
  });

  it('rejects publishing drafts that contain unsupported node types', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Demo Tree',
      treeKey: 'demo-tree',
    });

    await service.saveWorkflowDraft('demo-tree', 1, {
      draftRevision: 1,
      name: 'Demo Tree',
      nodes: [
        {
          nodeKey: 'human-review',
          displayName: 'Human Review',
          nodeType: 'human',
          provider: null,
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: null,
        },
      ],
      edges: [],
    });

    await expect(service.validateWorkflowDraft('demo-tree', 1)).resolves.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ code: 'unsupported_node_type' })]),
    });

    await expect(service.publishWorkflowDraft('demo-tree', 1, {})).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'unsupported_node_type' })]),
      }),
    });
  });

  it('rejects publishing drafts that contain unsupported agent providers', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Provider Tree',
      treeKey: 'provider-tree',
    });

    await service.saveWorkflowDraft('provider-tree', 1, {
      draftRevision: 1,
      name: 'Provider Tree',
      nodes: [
        {
          nodeKey: 'agent-node',
          displayName: 'Agent Node',
          nodeType: 'agent',
          provider: 'codex',
            model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
        },
      ],
      edges: [],
    });

    const draftTree = db
      .select({ id: workflowTrees.id })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, 'provider-tree'), eq(workflowTrees.version, 1), eq(workflowTrees.status, 'draft')))
      .get();
    expect(draftTree).toBeDefined();

    db.update(treeNodes).set({ provider: 'unknown-provider' }).where(eq(treeNodes.workflowTreeId, draftTree?.id ?? -1)).run();

    await expect(service.validateWorkflowDraft('provider-tree', 1)).resolves.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ code: 'agent_provider_invalid' })]),
    });

    await expect(service.publishWorkflowDraft('provider-tree', 1, {})).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'agent_provider_invalid' })]),
      }),
    });
  });

  it('duplicates workflow trees into a new draft v1', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'design-implement-review',
      name: 'Demo Tree',
      treeKey: 'demo-tree',
    });

    await expect(
      service.duplicateWorkflowTree('demo-tree', {
        name: 'Demo Tree Copy',
        treeKey: 'demo-tree-copy',
        description: 'Copied workflow',
      }),
    ).resolves.toEqual({
      treeKey: 'demo-tree-copy',
      draftVersion: 1,
    });

    const draft = await service.getOrCreateWorkflowDraft('demo-tree-copy');
    expect(draft.version).toBe(1);
    expect(draft.treeKey).toBe('demo-tree-copy');
    expect(draft.nodes.map(node => node.nodeKey)).toEqual(expect.arrayContaining(['design', 'implement', 'review']));
    expect(draft.edges.length).toBeGreaterThan(0);
  });

  it('returns conflict when create draft insert loses a post-check unique race', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const { proxiedDatabase, wasInjected } = createDatabaseWithWorkflowTreeInsertUniqueRace(db);
    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    await expect(
      raceService.createWorkflowDraft({
        template: 'blank',
        name: 'Race Create Tree',
        treeKey: 'race-create-tree',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Workflow tree "race-create-tree" already exists.',
    });

    expect(wasInjected()).toBe(true);
  });

  it('returns conflict when duplicate insert loses a post-check unique race', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const bootstrapService = createDashboardService({ dependencies });
    await bootstrapService.createWorkflowDraft({
      template: 'blank',
      name: 'Duplicate Source Tree',
      treeKey: 'duplicate-source-tree',
    });

    const { proxiedDatabase, wasInjected } = createDatabaseWithWorkflowTreeInsertUniqueRace(db);
    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    await expect(
      raceService.duplicateWorkflowTree('duplicate-source-tree', {
        name: 'Duplicate Copy Tree',
        treeKey: 'duplicate-copy-tree',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Workflow tree "duplicate-copy-tree" already exists.',
    });

    expect(wasInjected()).toBe(true);
  });

  it('rejects underscore workflow tree keys across draft lifecycle actions', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await expect(
      service.createWorkflowDraft({
        template: 'design-implement-review',
        name: 'Design Tree',
        treeKey: 'design_tree',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: 'Workflow tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
    });

    await expect(service.getOrCreateWorkflowDraft('design_tree')).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: 'Workflow tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
    });
  });

  it('seeds design-implement-review with an initial runnable design node', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'design-implement-review',
      name: 'Demo Tree',
      treeKey: 'demo-tree',
    });

    const draft = await service.getOrCreateWorkflowDraft('demo-tree');
    expect(draft.initialRunnableNodeKeys).toEqual(['design']);
    expect(draft.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceNodeKey: 'design',
          targetNodeKey: 'implement',
          auto: true,
        }),
        expect.objectContaining({
          sourceNodeKey: 'implement',
          targetNodeKey: 'review',
          auto: true,
        }),
        expect.objectContaining({
          sourceNodeKey: 'review',
          targetNodeKey: 'implement',
          auto: false,
          guardExpression: { field: 'decision', operator: '==', value: 'changes_requested' },
        }),
      ]),
    );
    const reviewNode = draft.nodes.find(node => node.nodeKey === 'review');
    expect(reviewNode?.promptTemplate?.content).toContain('ALPHRED_ROUTING_CONTRACT_V1');
    expect(reviewNode?.promptTemplate?.content).toContain('result.metadata.routingDecision');
    expect(reviewNode?.promptTemplate?.content).toContain(
      'result.metadata.routingDecision: <approved|changes_requested|blocked|retry>',
    );
    expect(reviewNode?.promptTemplate?.content).toContain('`changes_requested`');
    expect(reviewNode?.promptTemplate?.content).toContain('`approved`');

    const validation = await service.validateWorkflowDraft('demo-tree', 1);
    expect(validation.initialRunnableNodeKeys).toEqual(['design']);
    expect(validation.errors).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'no_initial_nodes' })]),
    );
  });

  it('returns concurrent draft when bootstrap hits single-draft unique constraint', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const bootstrapService = createDashboardService({ dependencies });
    await bootstrapService.createWorkflowDraft({
      template: 'design-implement-review',
      name: 'Single Draft Race Tree',
      treeKey: 'single-draft-race-tree',
    });
    await bootstrapService.publishWorkflowDraft('single-draft-race-tree', 1, {});

    let injectedConcurrentDraft = false;
    const originalTransaction = db.transaction.bind(db);
    const proxiedDatabase = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return ((callback: (tx: unknown) => unknown) => {
            if (!injectedConcurrentDraft) {
              injectedConcurrentDraft = true;
              const publishedVersions = target
                .select({
                  version: workflowTrees.version,
                  name: workflowTrees.name,
                  description: workflowTrees.description,
                })
                .from(workflowTrees)
                .where(and(eq(workflowTrees.treeKey, 'single-draft-race-tree'), eq(workflowTrees.status, 'published')))
                .all();
              const latestPublished = publishedVersions.reduce<(typeof publishedVersions)[number] | null>(
                (latest, current) => (latest === null || current.version > latest.version ? current : latest),
                null,
              );
              if (latestPublished) {
                target
                  .insert(workflowTrees)
                  .values({
                    treeKey: 'single-draft-race-tree',
                    version: latestPublished.version + 2,
                    status: 'draft',
                    name: latestPublished.name,
                    description: latestPublished.description,
                  })
                  .run();
              }
            }
            return originalTransaction((tx) => callback(tx));
          }) as typeof db.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    const draft = await raceService.getOrCreateWorkflowDraft('single-draft-race-tree');
    expect(injectedConcurrentDraft).toBe(true);
    expect(draft.version).toBe(3);

    const persistedDraft = db
      .select({ id: workflowTrees.id })
      .from(workflowTrees)
      .where(
        and(
          eq(workflowTrees.treeKey, 'single-draft-race-tree'),
          eq(workflowTrees.version, 3),
          eq(workflowTrees.status, 'draft'),
        ),
      )
      .get();
    expect(persistedDraft).toBeDefined();
  });

  it('retries draft bootstrap when a concurrent publish claims the next version', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const bootstrapService = createDashboardService({ dependencies });
    await bootstrapService.createWorkflowDraft({
      template: 'design-implement-review',
      name: 'Race Publish Tree',
      treeKey: 'race-publish-tree',
    });
    await bootstrapService.publishWorkflowDraft('race-publish-tree', 1, {});

    let injectedConcurrentPublish = false;
    const originalTransaction = db.transaction.bind(db);
    const proxiedDatabase = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return ((callback: (tx: unknown) => unknown) => {
            if (!injectedConcurrentPublish) {
              injectedConcurrentPublish = true;
              const publishedVersions = target
                .select({
                  version: workflowTrees.version,
                  name: workflowTrees.name,
                  description: workflowTrees.description,
                })
                .from(workflowTrees)
                .where(and(eq(workflowTrees.treeKey, 'race-publish-tree'), eq(workflowTrees.status, 'published')))
                .all();
              const latestPublished = publishedVersions.reduce<(typeof publishedVersions)[number] | null>(
                (latest, current) => (latest === null || current.version > latest.version ? current : latest),
                null,
              );
              if (latestPublished) {
                target.insert(workflowTrees).values({
                  treeKey: 'race-publish-tree',
                  version: latestPublished.version + 1,
                  status: 'published',
                  name: latestPublished.name,
                  description: latestPublished.description,
                }).run();
              }
            }
            return originalTransaction((tx) => callback(tx));
          }) as typeof db.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    const draft = await raceService.getOrCreateWorkflowDraft('race-publish-tree');
    expect(injectedConcurrentPublish).toBe(true);
    expect(draft.version).toBe(3);

    const persistedDraft = db
      .select({ id: workflowTrees.id })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, 'race-publish-tree'), eq(workflowTrees.version, 3), eq(workflowTrees.status, 'draft')))
      .get();
    expect(persistedDraft).toBeDefined();
  });

  it('returns conflict when draft bootstrap keeps racing on version allocation', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const bootstrapService = createDashboardService({ dependencies });
    await bootstrapService.createWorkflowDraft({
      template: 'design-implement-review',
      name: 'Hot Race Tree',
      treeKey: 'hot-race-tree',
    });
    await bootstrapService.publishWorkflowDraft('hot-race-tree', 1, {});

    const originalTransaction = db.transaction.bind(db);
    const proxiedDatabase = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return ((callback: (tx: unknown) => unknown) => {
            const publishedVersions = target
              .select({
                version: workflowTrees.version,
                name: workflowTrees.name,
                description: workflowTrees.description,
              })
              .from(workflowTrees)
              .where(and(eq(workflowTrees.treeKey, 'hot-race-tree'), eq(workflowTrees.status, 'published')))
              .all();
            const latestPublished = publishedVersions.reduce<(typeof publishedVersions)[number] | null>(
              (latest, current) => (latest === null || current.version > latest.version ? current : latest),
              null,
            );
            if (latestPublished) {
              target.insert(workflowTrees).values({
                treeKey: 'hot-race-tree',
                version: latestPublished.version + 1,
                status: 'published',
                name: latestPublished.name,
                description: latestPublished.description,
              }).run();
            }
            return originalTransaction((tx) => callback(tx));
          }) as typeof db.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    await expect(raceService.getOrCreateWorkflowDraft('hot-race-tree')).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Workflow draft changed concurrently. Refresh the editor and try again.',
      details: expect.objectContaining({
        treeKey: 'hot-race-tree',
        attempts: 4,
      }),
    });
  });

  it('rolls back draft creation when cloning fails', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Demo Tree',
      treeKey: 'demo-tree',
    });
    await service.saveWorkflowDraft('demo-tree', 1, {
      draftRevision: 1,
      name: 'Demo Tree',
      nodes: [
        {
          nodeKey: 'design',
          displayName: 'Design',
          nodeType: 'agent',
          provider: 'codex',
            model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
        },
      ],
      edges: [],
    });
    await service.publishWorkflowDraft('demo-tree', 1, {});

    const publishedTree = db
      .select({ id: workflowTrees.id })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, 'demo-tree'), eq(workflowTrees.status, 'published')))
      .orderBy(workflowTrees.id)
      .get();
    expect(publishedTree).toBeDefined();

    const publishedNodeWithPrompt = db
      .select({ promptTemplateId: treeNodes.promptTemplateId })
      .from(treeNodes)
      .where(eq(treeNodes.workflowTreeId, publishedTree?.id ?? -1))
      .all()
      .find(node => node.promptTemplateId !== null);
    expect(publishedNodeWithPrompt?.promptTemplateId).toBeTypeOf('number');

    const conflictingTemplateId = publishedNodeWithPrompt?.promptTemplateId as number;
    db.insert(promptTemplates)
      .values({
        templateKey: `demo-tree/v2/prompt-template/${conflictingTemplateId}`,
        version: 1,
        content: 'Conflicting prompt template row',
        contentType: 'markdown',
      })
      .run();

    await expect(service.getOrCreateWorkflowDraft('demo-tree')).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
    });

    const drafts = db
      .select({ id: workflowTrees.id })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, 'demo-tree'), eq(workflowTrees.status, 'draft')))
      .all();
    expect(drafts).toHaveLength(0);
  });

  it('rejects saving drafts with invalid guard expressions', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Guard Tree',
      treeKey: 'guard-tree',
    });

    await expect(
      service.saveWorkflowDraft('guard-tree', 1, {
        draftRevision: 1,
        name: 'Guard Tree',
        nodes: [
          {
            nodeKey: 'a',
            displayName: 'A',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'A prompt', contentType: 'markdown' },
          },
          {
            nodeKey: 'b',
            displayName: 'B',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 20,
            position: null,
            promptTemplate: { content: 'B prompt', contentType: 'markdown' },
          },
        ],
        edges: [
          {
            sourceNodeKey: 'a',
            targetNodeKey: 'b',
            priority: 10,
            auto: false,
            guardExpression: { nope: true } as unknown as import('@alphred/shared').GuardExpression,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'guard_invalid' })]),
      }),
    });
  });

  it('rejects saving drafts with unsupported agent providers', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Provider Save Tree',
      treeKey: 'provider-save-tree',
    });

    await expect(
      service.saveWorkflowDraft('provider-save-tree', 1, {
        draftRevision: 1,
        name: 'Provider Save Tree',
        nodes: [
          {
            nodeKey: 'agent-node',
            displayName: 'Agent Node',
            nodeType: 'agent',
            provider: 'unknown-provider',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'agent_provider_invalid' })]),
      }),
    });
  });

  it('rejects execution permissions for non-codex providers', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Execution Permissions Tree',
      treeKey: 'execution-permissions-tree',
    });

    await expect(
      service.saveWorkflowDraft('execution-permissions-tree', 1, {
        draftRevision: 1,
        name: 'Execution Permissions Tree',
        nodes: [
          {
            nodeKey: 'agent-node',
            displayName: 'Agent Node',
            nodeType: 'agent',
            provider: 'claude',
            model: 'claude-3-7-sonnet-latest',
            executionPermissions: {
              sandboxMode: 'workspace-write',
            },
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'execution_permissions_provider_unsupported' })]),
      }),
    });
  });

  it('rejects execution permissions for non-agent nodes', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Execution Permission Node Types',
      treeKey: 'execution-permission-node-types',
    });

    await expect(
      service.saveWorkflowDraft('execution-permission-node-types', 1, {
        draftRevision: 1,
        name: 'Execution Permission Node Types',
        nodes: [
          {
            nodeKey: 'human-node',
            displayName: 'Human Node',
            nodeType: 'human',
            provider: null,
            model: null,
            executionPermissions: {
              sandboxMode: 'workspace-write',
            },
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'execution_permissions_non_agent' })]),
      }),
    });
  });

  it.each([
    {
      name: 'approval policy',
      code: 'execution_permissions_approval_policy_invalid',
      executionPermissions: { approvalPolicy: 'invalid-policy' } as unknown as ProviderExecutionPermissions,
    },
    {
      name: 'sandbox mode',
      code: 'execution_permissions_sandbox_mode_invalid',
      executionPermissions: { sandboxMode: 'invalid-sandbox' } as unknown as ProviderExecutionPermissions,
    },
    {
      name: 'network access',
      code: 'execution_permissions_network_access_invalid',
      executionPermissions: { networkAccessEnabled: 'true' } as unknown as ProviderExecutionPermissions,
    },
    {
      name: 'additional directories',
      code: 'execution_permissions_additional_directories_invalid',
      executionPermissions: { additionalDirectories: [' /tmp/ok ', '   '] },
    },
    {
      name: 'web search mode',
      code: 'execution_permissions_web_search_mode_invalid',
      executionPermissions: { webSearchMode: 'sometimes' } as unknown as ProviderExecutionPermissions,
    },
  ])('rejects invalid execution permissions: $name', async ({ code, executionPermissions }) => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Execution Permission Validation',
      treeKey: 'execution-permission-validation',
    });

    await expect(
      service.saveWorkflowDraft('execution-permission-validation', 1, {
        draftRevision: 1,
        name: 'Execution Permission Validation',
        nodes: [
          {
            nodeKey: 'agent-node',
            displayName: 'Agent Node',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            executionPermissions,
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code })]),
      }),
    });
  });

  it('persists execution permissions across save, publish, and draft bootstrap', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Execution Persist Tree',
      treeKey: 'execution-persist-tree',
    });

    const savedDraft = await service.saveWorkflowDraft('execution-persist-tree', 1, {
      draftRevision: 1,
      name: 'Execution Persist Tree',
      nodes: [
        {
          nodeKey: 'agent-node',
          displayName: 'Agent Node',
          nodeType: 'agent',
          provider: 'codex',
          model: 'gpt-5.3-codex',
          executionPermissions: {
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
            networkAccessEnabled: true,
            additionalDirectories: ['  /tmp/extra-a  ', '/tmp/extra-b'],
            webSearchMode: 'cached',
          },
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
        },
      ],
      edges: [],
    });

    expect(savedDraft.nodes[0]?.executionPermissions).toEqual({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: true,
      additionalDirectories: ['/tmp/extra-a', '/tmp/extra-b'],
      webSearchMode: 'cached',
    });

    await service.publishWorkflowDraft('execution-persist-tree', 1, {});
    const bootstrappedDraft = await service.getOrCreateWorkflowDraft('execution-persist-tree');

    expect(bootstrappedDraft.nodes[0]?.executionPermissions).toEqual({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: true,
      additionalDirectories: ['/tmp/extra-a', '/tmp/extra-b'],
      webSearchMode: 'cached',
    });
  });

  it('persists node role and maxChildren across save, publish, and draft bootstrap', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Fanout Persist Tree',
      treeKey: 'fanout-persist-tree',
    });

    const savedDraft = await service.saveWorkflowDraft('fanout-persist-tree', 1, {
      draftRevision: 1,
      name: 'Fanout Persist Tree',
      nodes: [
        {
          nodeKey: 'decompose',
          displayName: 'Decompose',
          nodeType: 'agent',
          nodeRole: 'spawner',
          maxChildren: 8,
          provider: 'codex',
          model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'Break down subtasks.', contentType: 'markdown' },
        },
        {
          nodeKey: 'review',
          displayName: 'Review',
          nodeType: 'agent',
          nodeRole: 'join',
          maxChildren: 12,
          provider: 'codex',
          model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 20,
          position: null,
          promptTemplate: { content: 'Review merged outputs.', contentType: 'markdown' },
        },
      ],
      edges: [
        {
          sourceNodeKey: 'decompose',
          targetNodeKey: 'review',
          routeOn: 'success',
          priority: 100,
          auto: true,
          guardExpression: null,
        },
      ],
    });

    expect(savedDraft.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: 'decompose', nodeRole: 'spawner', maxChildren: 8 }),
      expect.objectContaining({ nodeKey: 'review', nodeRole: 'join', maxChildren: 12 }),
    ]));

    await service.publishWorkflowDraft('fanout-persist-tree', 1, {});
    const bootstrappedDraft = await service.getOrCreateWorkflowDraft('fanout-persist-tree');
    expect(bootstrappedDraft.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKey: 'decompose', nodeRole: 'spawner', maxChildren: 8 }),
      expect.objectContaining({ nodeKey: 'review', nodeRole: 'join', maxChildren: 12 }),
    ]));
  });

  it('rejects unsupported node role values on save', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Node Role Invalid Tree',
      treeKey: 'node-role-invalid-tree',
    });

    await expect(
      service.saveWorkflowDraft('node-role-invalid-tree', 1, {
        draftRevision: 1,
        name: 'Node Role Invalid Tree',
        nodes: [
          {
            nodeKey: 'agent-node',
            displayName: 'Agent Node',
            nodeType: 'agent',
            nodeRole: 'invalid-role' as unknown as 'standard',
            maxChildren: 12,
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'node_role_invalid' })]),
      }),
    });
  });

  it('rejects invalid maxChildren values on save', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Max Children Invalid Tree',
      treeKey: 'max-children-invalid-tree',
    });

    await expect(
      service.saveWorkflowDraft('max-children-invalid-tree', 1, {
        draftRevision: 1,
        name: 'Max Children Invalid Tree',
        nodes: [
          {
            nodeKey: 'agent-node',
            displayName: 'Agent Node',
            nodeType: 'agent',
            nodeRole: 'standard',
            maxChildren: -1,
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Agent prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'max_children_invalid' })]),
      }),
    });
  });

  it('rejects non-agent spawner/join role configurations on save', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Role Type Validation Tree',
      treeKey: 'role-type-validation-tree',
    });

    await expect(
      service.saveWorkflowDraft('role-type-validation-tree', 1, {
        draftRevision: 1,
        name: 'Role Type Validation Tree',
        nodes: [
          {
            nodeKey: 'manual-review',
            displayName: 'Manual Review',
            nodeType: 'human',
            nodeRole: 'join',
            maxChildren: 12,
            provider: null,
            model: null,
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'node_role_requires_agent' })]),
      }),
    });
  });

  it('rejects spawner nodes that do not have exactly one success edge to a join node', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Spawner Edge Validation Tree',
      treeKey: 'spawner-edge-validation-tree',
    });

    await expect(
      service.saveWorkflowDraft('spawner-edge-validation-tree', 1, {
        draftRevision: 1,
        name: 'Spawner Edge Validation Tree',
        nodes: [
          {
            nodeKey: 'decompose',
            displayName: 'Decompose',
            nodeType: 'agent',
            nodeRole: 'spawner',
            maxChildren: 4,
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Break down subtasks.', contentType: 'markdown' },
          },
          {
            nodeKey: 'implement',
            displayName: 'Implement',
            nodeType: 'agent',
            nodeRole: 'standard',
            maxChildren: 12,
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 20,
            position: null,
            promptTemplate: { content: 'Implement tasks.', contentType: 'markdown' },
          },
        ],
        edges: [
          {
            sourceNodeKey: 'decompose',
            targetNodeKey: 'implement',
            routeOn: 'success',
            priority: 100,
            auto: true,
            guardExpression: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'spawner_success_target_not_join' })]),
      }),
    });
  });

  it('rejects saving drafts with negative transition priorities', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Priority Tree',
      treeKey: 'priority-tree',
    });

    await expect(
      service.saveWorkflowDraft('priority-tree', 1, {
        draftRevision: 1,
        name: 'Priority Tree',
        nodes: [
          {
            nodeKey: 'a',
            displayName: 'A',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'A prompt', contentType: 'markdown' },
          },
          {
            nodeKey: 'b',
            displayName: 'B',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 20,
            position: null,
            promptTemplate: { content: 'B prompt', contentType: 'markdown' },
          },
        ],
        edges: [
          {
            sourceNodeKey: 'a',
            targetNodeKey: 'b',
            priority: -1,
            auto: true,
            guardExpression: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'transition_priority_invalid' })]),
      }),
    });
  });

  it('rejects saving drafts with duplicate node sequence indexes', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Sequence Tree',
      treeKey: 'sequence-tree',
    });

    await expect(
      service.saveWorkflowDraft('sequence-tree', 1, {
        draftRevision: 1,
        name: 'Sequence Tree',
        nodes: [
          {
            nodeKey: 'a',
            displayName: 'A',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'A prompt', contentType: 'markdown' },
          },
          {
            nodeKey: 'b',
            displayName: 'B',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'B prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: expect.objectContaining({
        errors: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_node_sequence_index' })]),
      }),
    });
  });

  it('normalizes node and edge keys before saving drafts', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Whitespace Tree',
      treeKey: 'whitespace-tree',
    });

    const savedDraft = await service.saveWorkflowDraft('whitespace-tree', 1, {
      draftRevision: 1,
      name: 'Whitespace Tree',
      nodes: [
        {
          nodeKey: ' source ',
          displayName: 'Source',
          nodeType: 'agent',
          provider: 'codex',
            model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'Source prompt', contentType: 'markdown' },
        },
        {
          nodeKey: 'target ',
          displayName: 'Target',
          nodeType: 'agent',
          provider: 'codex',
            model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 20,
          position: null,
          promptTemplate: { content: 'Target prompt', contentType: 'markdown' },
        },
      ],
      edges: [
        {
          sourceNodeKey: 'source',
          targetNodeKey: ' target',
          priority: 0,
          auto: true,
          guardExpression: null,
        },
      ],
    });

    expect(savedDraft.nodes.map(node => node.nodeKey)).toEqual(['source', 'target']);
    expect(savedDraft.edges).toEqual([
      expect.objectContaining({
        sourceNodeKey: 'source',
        targetNodeKey: 'target',
      }),
    ]);
  });

  it('requires the exact next draft revision when saving', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const service = createDashboardService({ dependencies });

    await service.createWorkflowDraft({
      template: 'blank',
      name: 'Revision Tree',
      treeKey: 'revision-tree',
    });

    const savePayload = {
      name: 'Revision Tree',
      nodes: [
        {
          nodeKey: 'a',
          displayName: 'A',
          nodeType: 'agent' as const,
          provider: 'codex',
            model: 'gpt-5.3-codex',
          maxRetries: 0,
          sequenceIndex: 10,
          position: null,
          promptTemplate: { content: 'A prompt', contentType: 'markdown' as const },
        },
      ],
      edges: [],
    };

    await service.saveWorkflowDraft('revision-tree', 1, {
      draftRevision: 1,
      ...savePayload,
    });

    await expect(
      service.saveWorkflowDraft('revision-tree', 1, {
        draftRevision: 3,
        ...savePayload,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: expect.objectContaining({
        currentDraftRevision: 1,
        receivedDraftRevision: 3,
        expectedDraftRevision: 2,
      }),
    });
  });

  it('returns conflict when draft changes between revision check and save update', async () => {
    const { db, dependencies } = createHarness();
    migrateDatabase(db);

    const bootstrapService = createDashboardService({ dependencies });
    await bootstrapService.createWorkflowDraft({
      template: 'blank',
      name: 'Race Tree',
      treeKey: 'race-tree',
    });

    const draftTree = db
      .select({ id: workflowTrees.id, draftRevision: workflowTrees.draftRevision })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, 'race-tree'), eq(workflowTrees.version, 1), eq(workflowTrees.status, 'draft')))
      .get();
    expect(draftTree).toBeDefined();

    let injectConcurrentChange = true;
    const originalTransaction = db.transaction.bind(db);
    const proxiedDatabase = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return ((callback: (tx: unknown) => unknown) =>
            originalTransaction((tx) => {
              const originalUpdate = tx.update.bind(tx);
              const txProxy = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === 'update') {
                    return ((table: unknown) => {
                      const updateBuilder = originalUpdate(table as never);
                      if (!injectConcurrentChange || table !== workflowTrees || !draftTree) {
                        return updateBuilder;
                      }

                      const wrappedUpdateBuilder = {
                        set(values: unknown) {
                          const setBuilder = (updateBuilder as { set: (input: unknown) => unknown }).set(values) as {
                            where: (condition: unknown) => unknown;
                          };
                          return {
                            where(condition: unknown) {
                              const whereBuilder = setBuilder.where(condition) as { run: () => unknown };
                              return {
                                run() {
                                  if (injectConcurrentChange) {
                                    injectConcurrentChange = false;
                                    originalUpdate(workflowTrees)
                                      .set({
                                        status: 'published',
                                        draftRevision: draftTree.draftRevision + 1,
                                        updatedAt: '2026-02-22T00:00:00.000Z',
                                      })
                                      .where(eq(workflowTrees.id, draftTree.id))
                                      .run();
                                  }
                                  return whereBuilder.run();
                                },
                              };
                            },
                          };
                        },
                      };

                      return wrappedUpdateBuilder as unknown as ReturnType<typeof originalUpdate>;
                    }) as AlphredDatabase['update'];
                  }

                  const value = Reflect.get(txTarget, txProp, txReceiver);
                  return typeof value === 'function' ? value.bind(txTarget) : value;
                },
              });
              return callback(txProxy);
            })) as unknown as AlphredDatabase['transaction'];
        }

        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const raceService = createDashboardService({
      dependencies: {
        ...dependencies,
        openDatabase: () => proxiedDatabase,
      },
    });

    await expect(
      raceService.saveWorkflowDraft('race-tree', 1, {
        draftRevision: 1,
        name: 'Race Tree Updated',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            model: 'gpt-5.3-codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: 'Draft workflow changed while saving. Refresh the editor before saving again.',
    });
  });

  it('syncs repositories through ensureRepositoryClone and auth check adapters', async () => {
    const checkAuth = vi.fn(async () => ({
      authenticated: true,
      user: 'sync-user',
      scopes: ['repo'],
    } satisfies AuthStatus));

    const ensureRepositoryCloneMock: DashboardServiceDependencies['ensureRepositoryClone'] = vi.fn(async () => ({
      action: 'fetched' as const,
      repository: {
        id: 1,
        name: 'demo-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/repos/demo-repo',
        cloneStatus: 'cloned',
      } satisfies RepositoryConfig,
      sync: {
        mode: 'pull' as const,
        strategy: 'ff-only' as const,
        branch: 'main',
        status: 'updated' as const,
        conflictMessage: null,
      },
    }));

    const { db, dependencies } = createHarness({
      createScmProvider: () => ({ checkAuth }),
      ensureRepositoryClone: ensureRepositoryCloneMock,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.syncRepository('demo-repo');

    expect(result.action).toBe('fetched');
    expect(result.repository.cloneStatus).toBe('cloned');
    expect(result.sync.status).toBe('updated');
    expect(result.sync.strategy).toBe('ff-only');
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(ensureRepositoryCloneMock).toHaveBeenCalledTimes(1);
    expect(ensureRepositoryCloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: {
          mode: 'pull',
          strategy: 'ff-only',
        },
      }),
    );
  });

  it('falls back to fetched sync details when clone sync metadata is absent', async () => {
    const checkAuth = vi.fn(async () => ({
      authenticated: true,
      user: 'sync-user',
      scopes: ['repo'],
    } satisfies AuthStatus));

    const ensureRepositoryCloneMock: DashboardServiceDependencies['ensureRepositoryClone'] = vi.fn(async () => ({
      action: 'fetched' as const,
      repository: {
        id: 1,
        name: 'demo-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/repos/demo-repo',
        cloneStatus: 'cloned',
      } satisfies RepositoryConfig,
    }));

    const { db, dependencies } = createHarness({
      createScmProvider: () => ({ checkAuth }),
      ensureRepositoryClone: ensureRepositoryCloneMock,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.syncRepository('demo-repo');

    expect(result.sync).toEqual({
      mode: 'fetch',
      strategy: null,
      branch: 'main',
      status: 'fetched',
      conflictMessage: null,
    });
  });

  it('supports rebase sync strategy and surfaces conflict outcomes as 409 errors', async () => {
    const checkAuth = vi.fn(async () => ({
      authenticated: true,
      user: 'sync-user',
      scopes: ['repo'],
    } satisfies AuthStatus));

    const ensureRepositoryCloneMock: DashboardServiceDependencies['ensureRepositoryClone'] = vi.fn(async () => ({
      action: 'fetched' as const,
      repository: {
        id: 1,
        name: 'demo-repo',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        remoteRef: 'octocat/demo-repo',
        defaultBranch: 'main',
        branchTemplate: null,
        localPath: '/tmp/repos/demo-repo',
        cloneStatus: 'cloned',
      } satisfies RepositoryConfig,
      sync: {
        mode: 'pull' as const,
        strategy: 'rebase' as const,
        branch: 'main',
        status: 'conflicted' as const,
        conflictMessage: 'Sync conflict on branch "main" with strategy "rebase": could not apply 1234',
      },
    }));

    const { db, dependencies } = createHarness({
      createScmProvider: () => ({ checkAuth }),
      ensureRepositoryClone: ensureRepositoryCloneMock,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });

    await expect(service.syncRepository('demo-repo', { strategy: 'rebase' })).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'conflict',
      status: 409,
      message: 'Sync conflict on branch "main" with strategy "rebase": could not apply 1234',
    });
    expect(ensureRepositoryCloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: {
          mode: 'pull',
          strategy: 'rebase',
        },
      }),
    );
  });

  it('creates github repositories through the shared db schema', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const result = await service.createRepository({
      name: 'new-repo',
      provider: 'github',
      remoteRef: 'octocat/new-repo',
    });

    expect(result.repository.name).toBe('new-repo');
    expect(result.repository.provider).toBe('github');
    expect(result.repository.remoteRef).toBe('octocat/new-repo');
    expect(result.repository.remoteUrl).toBe('https://github.com/octocat/new-repo.git');
    expect(result.repository.cloneStatus).toBe('pending');
    expect(result.repository.localPath).toBeNull();

    const repositoriesResponse = await service.listRepositories();
    expect(repositoriesResponse.some(repository => repository.name === 'new-repo')).toBe(true);
  });

  it.each([
    {
      name: '',
    },
    {
      name: '   ',
    },
  ])('rejects empty repository names on createRepository: "$name"', async ({ name }) => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    await expect(
      service.createRepository({
        name,
        provider: 'github',
        remoteRef: 'octocat/new-repo',
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'invalid_request',
      status: 400,
      message: 'Repository name cannot be empty.',
    });
  });

  it('rejects invalid github remote refs on createRepository', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    await expect(
      service.createRepository({
        name: 'new-repo',
        provider: 'github',
        remoteRef: 'octocat',
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'invalid_request',
      status: 400,
    });
  });

  it('rejects duplicate repository names on createRepository', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    await expect(
      service.createRepository({
        name: 'demo-repo',
        provider: 'github',
        remoteRef: 'octocat/demo-repo',
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'conflict',
      status: 409,
      message: 'Repository "demo-repo" already exists.',
    });
  });

  it('translates planner missing-tree failures to not_found errors', async () => {
    const { db, dependencies } = createHarness({
      createSqlWorkflowPlanner: () => ({
        materializeRun: () => {
          throw {
            code: 'WORKFLOW_TREE_NOT_FOUND',
            message: 'No workflow tree found for tree_key="missing".',
          };
        },
      }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowPlanner']>,
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });

    await expect(service.launchWorkflowRun({ treeKey: 'missing', executionMode: 'sync' })).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'not_found',
      status: 404,
    });
  });

  it.each([
    {
      repositoryName: '',
    },
    {
      repositoryName: '   ',
    },
  ])('rejects empty repositoryName input when launching runs', async ({ repositoryName }) => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        repositoryName,
      });
      throw new Error('Expected launchWorkflowRun to throw for empty repositoryName input.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'repositoryName cannot be empty when provided.',
      });
    }
  });

  it('rejects invalid executionMode input when launching runs', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionMode: 'queued' as unknown as 'async',
      });
      throw new Error('Expected launchWorkflowRun to throw for invalid executionMode input.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'executionMode must be "async" or "sync".',
      });
    }
  });

  it('rejects invalid executionScope input when launching runs', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionScope: 'partial' as unknown as 'full',
      });
      throw new Error('Expected launchWorkflowRun to throw for invalid executionScope input.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'executionScope must be "full" or "single_node".',
      });
    }
  });

  it('rejects nodeSelector when executionScope is not single_node', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        nodeSelector: {
          type: 'next_runnable',
        },
      });
      throw new Error('Expected launchWorkflowRun to throw when nodeSelector is used outside single_node scope.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'nodeSelector requires executionScope "single_node".',
      });
    }
  });

  it('rejects empty nodeSelector.nodeKey values for single-node launches', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionScope: 'single_node',
        nodeSelector: {
          type: 'node_key',
          nodeKey: '   ',
        },
      });
      throw new Error('Expected launchWorkflowRun to throw when nodeSelector.nodeKey is empty.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'nodeSelector.nodeKey cannot be empty.',
      });
    }
  });

  it('rejects unsupported nodeSelector types for single-node launches', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionScope: 'single_node',
        nodeSelector: {
          type: 'unsupported',
        } as unknown as {
          type: 'next_runnable';
        },
      });
      throw new Error('Expected launchWorkflowRun to throw when nodeSelector.type is unsupported.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'nodeSelector.type must be "next_runnable" or "node_key".',
      });
    }
  });

  it('maps single-node selector validation failures to invalid_request errors', async () => {
    const validateSingleNodeSelection = vi.fn(() => {
      throw new WorkflowRunExecutionValidationError(
        'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_FOUND',
        'Node selector "node_key" did not match any node for key "missing".',
        {
          workflowRunId: 1,
          nodeSelector: {
            type: 'node_key',
            nodeKey: 'missing',
          },
        },
      );
    });
    const executeRun = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'completed',
      },
      executedNodes: 3,
    }));
    const executeSingleNode = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'run_terminal',
      },
      executedNodes: 1,
    }));
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          executeSingleNode,
          validateSingleNodeSelection,
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    await expect(
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        executionMode: 'async',
        executionScope: 'single_node',
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'missing',
        },
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'invalid_request',
      status: 400,
      message: 'Node selector "node_key" did not match any node for key "missing".',
      details: {
        code: 'WORKFLOW_RUN_SINGLE_NODE_SELECTOR_NOT_FOUND',
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'missing',
        },
      },
    });
  });

  it('returns not_found when launching a repository-scoped run for a missing repository', async () => {
    const { db, dependencies } = createHarness();
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    await expect(
      service.launchWorkflowRun({
        treeKey: 'demo-tree',
        repositoryName: 'missing-repo',
        executionMode: 'sync',
      }),
    ).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'not_found',
      status: 404,
      message: 'Repository "missing-repo" was not found.',
    });
  });

  it('returns sync launch execution details when executor completes', async () => {
    const executeRun = vi.fn(async () => ({
      finalStep: {
        runStatus: 'completed',
        outcome: 'completed',
      },
      executedNodes: 3,
    }));
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({ executeRun }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    const result = await service.launchWorkflowRun({
      treeKey: 'demo-tree',
      executionMode: 'sync',
    });

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      workflowRunId: result.workflowRunId,
      mode: 'sync',
      status: 'completed',
      runStatus: 'completed',
      executionOutcome: 'completed',
      executedNodes: 3,
    });
  });

  it('dispatches pause run control and returns the normalized control result', async () => {
    const pauseRun = vi.fn(async () => ({
      action: 'pause' as const,
      outcome: 'applied' as const,
      workflowRunId: 42,
      previousRunStatus: 'running' as const,
      runStatus: 'paused' as const,
      retriedRunNodeIds: [] as number[],
    }));

    const { dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun: vi.fn(),
          cancelRun: vi.fn(),
          pauseRun,
          resumeRun: vi.fn(),
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    const service = createDashboardService({ dependencies });

    const result = await service.controlWorkflowRun(42, 'pause');

    expect(pauseRun).toHaveBeenCalledWith({
      workflowRunId: 42,
    });
    expect(result).toEqual({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: 42,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });
  });

  it('maps typed workflow run control errors to dashboard conflict errors', async () => {
    const pauseRun = vi.fn(async () => {
      throw new WorkflowRunControlError(
        'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
        'Cannot pause workflow run id=9 from status "pending".',
        {
          action: 'pause',
          workflowRunId: 9,
          runStatus: 'pending',
        },
      );
    });

    const { dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun: vi.fn(),
          cancelRun: vi.fn(),
          pauseRun,
          resumeRun: vi.fn(),
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    const service = createDashboardService({ dependencies });

    await expect(service.controlWorkflowRun(9, 'pause')).rejects.toMatchObject({
      name: 'DashboardIntegrationError',
      code: 'conflict',
      status: 409,
      message: 'Cannot pause workflow run id=9 from status "pending".',
      details: {
        controlCode: 'WORKFLOW_RUN_CONTROL_INVALID_TRANSITION',
        action: 'pause',
        workflowRunId: 9,
        runStatus: 'pending',
      },
    });
  });

  it('starts a background execution for resume control when run transitions back to running', async () => {
    const resumeRun = vi.fn(async () => ({
      action: 'resume' as const,
      outcome: 'applied' as const,
      workflowRunId: 77,
      previousRunStatus: 'paused' as const,
      runStatus: 'running' as const,
      retriedRunNodeIds: [] as number[],
    }));
    const executeRun = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });

    const { dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          cancelRun: vi.fn(),
          pauseRun: vi.fn(),
          resumeRun,
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    const service = createDashboardService({ dependencies });

    const result = await service.controlWorkflowRun(77, 'resume');

    expect(resumeRun).toHaveBeenCalledWith({
      workflowRunId: 77,
    });
    expect(result).toEqual({
      action: 'resume',
      outcome: 'applied',
      workflowRunId: 77,
      previousRunStatus: 'paused',
      runStatus: 'running',
      retriedRunNodeIds: [],
    });
    expect(service.hasBackgroundExecution(77)).toBe(true);

    await waitForBackgroundExecution(service, 77);

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(service.hasBackgroundExecution(77)).toBe(false);
  });

  it('falls back to cwd when resume control has only removed run worktrees', async () => {
    const resumeRun = vi.fn(async () => ({
      action: 'resume' as const,
      outcome: 'applied' as const,
      workflowRunId: 1,
      previousRunStatus: 'paused' as const,
      runStatus: 'running' as const,
      retriedRunNodeIds: [] as number[],
    }));
    const executeRun = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });
    const createWorktreeManager = vi.fn(() => ({
      createRunWorktree: vi.fn(),
      cleanupRun: vi.fn(),
    }));

    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          cancelRun: vi.fn(),
          pauseRun: vi.fn(),
          resumeRun,
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
      createWorktreeManager,
    });
    seedRunData(db);
    db.update(runWorktrees)
      .set({
        status: 'removed',
        removedAt: '2026-02-17T20:03:00.000Z',
      })
      .where(eq(runWorktrees.workflowRunId, 1))
      .run();

    const service = createDashboardService({
      dependencies,
      cwd: '/work/alphred/fallback-cwd',
    });

    await service.controlWorkflowRun(1, 'resume');
    await waitForBackgroundExecution(service, 1);

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(executeRun).toHaveBeenCalledWith({
      workflowRunId: 1,
      options: {
        workingDirectory: '/work/alphred/fallback-cwd',
      },
    });
    expect(createWorktreeManager).not.toHaveBeenCalled();
  });

  it('keeps resume control idempotent while a background execution is already active', async () => {
    const resumeRun = vi
      .fn()
      .mockResolvedValueOnce({
        action: 'resume' as const,
        outcome: 'applied' as const,
        workflowRunId: 88,
        previousRunStatus: 'paused' as const,
        runStatus: 'running' as const,
        retriedRunNodeIds: [] as number[],
      })
      .mockResolvedValueOnce({
        action: 'resume' as const,
        outcome: 'noop' as const,
        workflowRunId: 88,
        previousRunStatus: 'running' as const,
        runStatus: 'running' as const,
        retriedRunNodeIds: [] as number[],
      });
    const executeRun = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });

    const { dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          cancelRun: vi.fn(),
          pauseRun: vi.fn(),
          resumeRun,
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    const service = createDashboardService({ dependencies });

    const firstResult = await service.controlWorkflowRun(88, 'resume');
    expect(firstResult.outcome).toBe('applied');
    expect(service.hasBackgroundExecution(88)).toBe(true);

    const secondResult = await service.controlWorkflowRun(88, 'resume');
    expect(secondResult.outcome).toBe('noop');

    await waitForBackgroundExecution(service, 88);

    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(service.hasBackgroundExecution(88)).toBe(false);
  });

  it('reschedules resume control when the prior background execution is still draining', async () => {
    let resolveDrainingExecution:
      | ((value: { finalStep: { runStatus: 'paused'; outcome: string }; executedNodes: number }) => void)
      | undefined;
    const drainingExecution = new Promise<{ finalStep: { runStatus: 'paused'; outcome: string }; executedNodes: number }>(
      resolve => {
        resolveDrainingExecution = resolve;
      },
    );

    let resolveRescheduledExecutionStarted: (() => void) | undefined;
    const rescheduledExecutionStarted = new Promise<void>(resolve => {
      resolveRescheduledExecutionStarted = resolve;
    });

    let executeCallCount = 0;
    const executeRun = vi.fn(async () => {
      executeCallCount += 1;
      if (executeCallCount === 1) {
        return drainingExecution;
      }

      resolveRescheduledExecutionStarted?.();
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });
    const resumeRun = vi.fn(async () => ({
      action: 'resume' as const,
      outcome: 'applied' as const,
      workflowRunId: 1,
      previousRunStatus: 'paused' as const,
      runStatus: 'running' as const,
      retriedRunNodeIds: [] as number[],
    }));

    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({
          executeRun,
          cancelRun: vi.fn(),
          pauseRun: vi.fn(),
          resumeRun,
          retryRun: vi.fn(),
        }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);
    db.update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
      })
      .where(eq(workflowRuns.id, 1))
      .run();

    const service = createDashboardService({ dependencies });

    await service.controlWorkflowRun(1, 'resume');
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(service.hasBackgroundExecution(1)).toBe(true);

    await service.controlWorkflowRun(1, 'resume');
    expect(executeRun).toHaveBeenCalledTimes(1);

    expect(resolveDrainingExecution).toBeDefined();
    resolveDrainingExecution?.({
      finalStep: {
        runStatus: 'paused',
        outcome: 'paused',
      },
      executedNodes: 0,
    });

    const didReschedule = await Promise.race([
      rescheduledExecutionStarted.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ]);

    expect(didReschedule).toBe(true);
    expect(executeRun).toHaveBeenCalledTimes(2);

    await waitForBackgroundExecution(service, 1);

    expect(service.hasBackgroundExecution(1)).toBe(false);
  });

  it('rejects invalid run ids for control actions', () => {
    const { dependencies } = createHarness();
    const service = createDashboardService({ dependencies });

    try {
      service.controlWorkflowRun(0, 'cancel');
      throw new Error('Expected controlWorkflowRun to throw for invalid run id.');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DashboardIntegrationError',
        code: 'invalid_request',
        status: 400,
        message: 'Run id must be a positive integer.',
      });
    }
  });

  it('reports background execution count while async run execution is in flight', async () => {
    const executeRun = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        finalStep: {
          runStatus: 'completed',
          outcome: 'completed',
        },
        executedNodes: 1,
      };
    });
    const { db, dependencies } = createHarness({
      createSqlWorkflowExecutor: () =>
        ({ executeRun }) as unknown as ReturnType<DashboardServiceDependencies['createSqlWorkflowExecutor']>,
    });
    seedRunData(db);
    const service = createDashboardService({ dependencies });

    expect(service.getBackgroundExecutionCount()).toBe(0);

    const result = await service.launchWorkflowRun({
      treeKey: 'demo-tree',
      executionMode: 'async',
    });

    expect(service.getBackgroundExecutionCount()).toBe(1);
    expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(true);

    await waitForBackgroundExecution(service, result.workflowRunId);

    expect(service.getBackgroundExecutionCount()).toBe(0);
    expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
  });

  it('checks github auth status through scm provider adapter', async () => {
    const checkAuth = vi.fn(async () => ({
      authenticated: false,
      error: 'Run gh auth login',
    } satisfies AuthStatus));

    const { db, dependencies } = createHarness({
      createScmProvider: () => ({ checkAuth }),
    });
    seedRunData(db);

    const service = createDashboardService({ dependencies });
    const auth = await service.checkGitHubAuth();

    expect(auth.authenticated).toBe(false);
    expect(auth.error).toBe('Run gh auth login');
    expect(checkAuth).toHaveBeenCalledTimes(1);
  });
});
