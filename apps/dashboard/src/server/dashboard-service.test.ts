import { describe, expect, it, vi } from 'vitest';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner } from '@alphred/core';
import {
  createDatabase,
  migrateDatabase,
  phaseArtifacts,
  repositories,
  routingDecisions,
  runNodes,
  runWorktrees,
  treeNodes,
  transitionRunNodeStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
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

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && service.hasBackgroundExecution(result.workflowRunId)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(2);
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

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && service.hasBackgroundExecution(result.workflowRunId)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(service.hasBackgroundExecution(result.workflowRunId)).toBe(false);
      expect(createWorktreeManager).toHaveBeenCalledTimes(2);
      expect(executeRun).toHaveBeenCalledTimes(1);
      expect(cleanupRun).toHaveBeenCalledTimes(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
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
    expect(runsResponse[0]?.nodeSummary.completed).toBe(1);

    const runDetail = await service.getWorkflowRunDetail(1);
    expect(runDetail.run.id).toBe(1);
    expect(runDetail.nodes).toHaveLength(1);
    expect(runDetail.nodes[0]?.latestArtifact?.artifactType).toBe('report');
    expect(runDetail.nodes[0]?.latestRoutingDecision?.decisionType).toBe('approved');
    expect(runDetail.worktrees).toHaveLength(1);
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
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(ensureRepositoryCloneMock).toHaveBeenCalledTimes(1);
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
