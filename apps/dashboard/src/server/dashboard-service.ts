import { join } from 'node:path';
import { resolveAgentProvider } from '@alphred/agents';
import {
  createSqlWorkflowExecutor,
  createSqlWorkflowPlanner,
  type PhaseProviderResolver,
} from '@alphred/core';
import {
  createDatabase,
  eq,
  migrateDatabase,
  repositories as repositoriesTable,
  type AlphredDatabase,
} from '@alphred/db';
import {
  WorktreeManager,
  createScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import type {
  AuthStatus,
} from '@alphred/shared';
import { createBackgroundExecutionManager } from './background-execution';
import { ensureDashboardDefaultWorkflows } from './dashboard-default-workflows';
import { DashboardIntegrationError, toDashboardIntegrationError } from './dashboard-errors';
import { createRepositoryOperations } from './repository-operations';
import { createRunOperations, createWorkflowRunLaunchCoordinator } from './run-operations';
import { resolveDatabasePath } from './dashboard-utils';
import { createStoryBreakdownRunOperations } from './story-breakdown-run-operations';
import { runStoryWorkflowOrchestration } from './story-workflow-orchestration';
import { createWorkItemOperations, validateMoveWorkItemStatusRequest } from './work-item-operations';
import { createWorkflowDraftOperations } from './workflow-draft-operations';
import { createWorkflowOperations } from './workflow-operations';

export type DashboardServiceDependencies = {
  openDatabase: (path: string) => AlphredDatabase;
  migrateDatabase: (db: AlphredDatabase) => void;
  closeDatabase: (db: AlphredDatabase) => void;
  resolveProvider: PhaseProviderResolver;
  createScmProvider: (config: ScmProviderConfig) => {
    checkAuth: (environment?: NodeJS.ProcessEnv) => Promise<AuthStatus>;
  };
  ensureRepositoryClone: typeof ensureRepositoryClone;
  createSqlWorkflowPlanner: typeof createSqlWorkflowPlanner;
  createSqlWorkflowExecutor: typeof createSqlWorkflowExecutor;
  createWorktreeManager: (db: AlphredDatabase, environment: NodeJS.ProcessEnv) => Pick<
    WorktreeManager,
    'createRunWorktree' | 'cleanupRun'
  >;
};

const defaultDependencies: DashboardServiceDependencies = {
  openDatabase: path => createDatabase(path),
  migrateDatabase: db => migrateDatabase(db),
  closeDatabase: db => db.$client.close(),
  resolveProvider: providerName => resolveAgentProvider(providerName),
  createScmProvider: config => createScmProvider(config),
  ensureRepositoryClone: params => ensureRepositoryClone(params),
  createSqlWorkflowPlanner: db => createSqlWorkflowPlanner(db),
  createSqlWorkflowExecutor: (db, dependencies) => createSqlWorkflowExecutor(db, dependencies),
  createWorktreeManager: (db, environment) =>
    new WorktreeManager(db, {
      worktreeBase: join(resolveSandboxDir(environment), 'worktrees'),
      environment,
    }),
};

export type DashboardService = ReturnType<typeof createDashboardService>;

export function createDashboardService(options: {
  dependencies?: DashboardServiceDependencies;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}) {
  const dependencies = options.dependencies ?? defaultDependencies;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  async function withDatabase<T>(operation: (db: AlphredDatabase) => Promise<T> | T): Promise<T> {
    const db = dependencies.openDatabase(resolveDatabasePath(environment, cwd));
    let result: T | undefined;
    let caughtError: unknown = null;

    try {
      dependencies.migrateDatabase(db);
      ensureDashboardDefaultWorkflows(db);
      result = await operation(db);
    } catch (error) {
      caughtError = toDashboardIntegrationError(error);
    }

    try {
      dependencies.closeDatabase(db);
    } catch (error) {
      if (caughtError === null) {
        caughtError = toDashboardIntegrationError(error, 'Dashboard integration cleanup failed.');
      }
    }

    if (caughtError !== null) {
      throw caughtError;
    }

    return result as T;
  }

  const backgroundExecution = createBackgroundExecutionManager({
    withDatabase,
    dependencies: {
      createSqlWorkflowExecutor: dependencies.createSqlWorkflowExecutor,
      resolveProvider: dependencies.resolveProvider,
      createWorktreeManager: dependencies.createWorktreeManager,
    },
    environment,
    cwd,
  });

  const workflowOperations = createWorkflowOperations({ withDatabase, environment });
  const workflowDraftOperations = createWorkflowDraftOperations({ withDatabase, environment });
  const repositoryOperations = createRepositoryOperations({
    withDatabase,
    dependencies: {
      createScmProvider: dependencies.createScmProvider,
      ensureRepositoryClone: dependencies.ensureRepositoryClone,
    },
    environment,
  });
  const workItemOperations = createWorkItemOperations({ withDatabase });
  const runOperations = createRunOperations({
    withDatabase,
    dependencies: {
      createSqlWorkflowPlanner: dependencies.createSqlWorkflowPlanner,
      createSqlWorkflowExecutor: dependencies.createSqlWorkflowExecutor,
      resolveProvider: dependencies.resolveProvider,
      createWorktreeManager: dependencies.createWorktreeManager,
    },
    environment,
    cwd,
    repositoryAuthDependencies: {
      createScmProvider: dependencies.createScmProvider,
    },
    backgroundExecution,
  });
  const workflowRunLaunchCoordinator = createWorkflowRunLaunchCoordinator({
    dependencies: {
      createSqlWorkflowPlanner: dependencies.createSqlWorkflowPlanner,
      createSqlWorkflowExecutor: dependencies.createSqlWorkflowExecutor,
      resolveProvider: dependencies.resolveProvider,
      createWorktreeManager: dependencies.createWorktreeManager,
    },
    backgroundExecution,
    environment,
    cwd,
    repositoryAuthDependencies: {
      createScmProvider: dependencies.createScmProvider,
    },
  });
  const storyBreakdownRunOperations = createStoryBreakdownRunOperations({
    withDatabase,
    dependencies: {
      prepareWorkflowRunLaunch: workflowRunLaunchCoordinator.prepareWorkflowRunLaunch,
      completeWorkflowRunLaunch: workflowRunLaunchCoordinator.completeWorkflowRunLaunch,
    },
    environment,
  });

  const taskRunAutolaunchEnabled = environment.ALPHRED_DASHBOARD_TASK_RUN_AUTOLAUNCH === '1';
  const configuredTaskRunTreeKey = (environment.ALPHRED_DASHBOARD_TASK_RUN_TREE_KEY ?? 'design-implement-review').trim();
  const taskRunTreeKey = configuredTaskRunTreeKey.length > 0 ? configuredTaskRunTreeKey : 'design-implement-review';

  async function resolveRepositoryNameById(repositoryId: number): Promise<string> {
    return withDatabase(db => {
      const repository = db
        .select({
          name: repositoriesTable.name,
        })
        .from(repositoriesTable)
        .where(eq(repositoriesTable.id, repositoryId))
        .get();
      if (!repository) {
        throw new DashboardIntegrationError('not_found', `Repository id=${repositoryId} was not found.`, {
          status: 404,
        });
      }
      return repository.name;
    });
  }

  async function moveWorkItemStatusWithTaskRunOrchestration(
    request: Parameters<typeof workItemOperations.moveWorkItemStatus>[0],
  ): Promise<Awaited<ReturnType<typeof workItemOperations.moveWorkItemStatus>>> {
    const shouldAttemptTaskRunAutolaunch =
      taskRunAutolaunchEnabled && request.toStatus === 'InProgress' && request.linkedWorkflowRunId === undefined;
    if (!shouldAttemptTaskRunAutolaunch) {
      return workItemOperations.moveWorkItemStatus(request);
    }

    validateMoveWorkItemStatusRequest(request);

    const existing = await workItemOperations.getWorkItem({
      repositoryId: request.repositoryId,
      workItemId: request.workItemId,
    });
    if (
      existing.workItem.type !== 'task'
      || existing.workItem.status !== 'Ready'
      || existing.workItem.revision !== request.expectedRevision
    ) {
      return workItemOperations.moveWorkItemStatus(request);
    }

    const repositoryName = await resolveRepositoryNameById(request.repositoryId);
    const policyConstraints =
      existing.workItem.effectivePolicy?.policy === undefined
        ? undefined
        : {
            allowedProviders: existing.workItem.effectivePolicy.policy.allowedProviders,
            allowedModels: existing.workItem.effectivePolicy.policy.allowedModels,
            allowedSkillIdentifiers: existing.workItem.effectivePolicy.policy.allowedSkillIdentifiers,
            allowedMcpServerIdentifiers: existing.workItem.effectivePolicy.policy.allowedMcpServerIdentifiers,
          };

    const launchedRun = await runOperations.launchWorkflowRun({
      treeKey: taskRunTreeKey,
      repositoryName,
      executionMode: 'async',
      policyConstraints,
    });

    try {
      return await workItemOperations.moveWorkItemStatus({
        ...request,
        linkedWorkflowRunId: launchedRun.workflowRunId,
      });
    } catch (error) {
      try {
        await runOperations.controlWorkflowRun(launchedRun.workflowRunId, 'cancel');
      } catch {
        // Best-effort cleanup if move fails after launching.
      }
      throw error;
    }
  }

  async function runStoryWorkflow(
    request: Parameters<typeof runStoryWorkflowOrchestration>[0]['request'],
  ): Promise<Awaited<ReturnType<typeof runStoryWorkflowOrchestration>>> {
    return runStoryWorkflowOrchestration({
      request,
      operations: {
        getWorkItem: workItemOperations.getWorkItem,
        listWorkItems: workItemOperations.listWorkItems,
        moveWorkItemStatus: moveWorkItemStatusWithTaskRunOrchestration,
        approveStoryBreakdown: workItemOperations.approveStoryBreakdown,
      },
    });
  }

  return {
    ...workflowOperations,
    ...workflowDraftOperations,
    ...repositoryOperations,
    ...workItemOperations,
    ...storyBreakdownRunOperations,
    runStoryWorkflow,
    moveWorkItemStatus: moveWorkItemStatusWithTaskRunOrchestration,
    ...runOperations,
  };
}
