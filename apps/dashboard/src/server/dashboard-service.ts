import { join } from 'node:path';
import { resolveAgentProvider } from '@alphred/agents';
import {
  createSqlWorkflowExecutor,
  createSqlWorkflowPlanner,
  type PhaseProviderResolver,
} from '@alphred/core';
import {
  createDatabase,
  migrateDatabase,
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
import { toDashboardIntegrationError } from './dashboard-errors';
import { createRepositoryOperations } from './repository-operations';
import { createRunOperations } from './run-operations';
import { resolveDatabasePath } from './dashboard-utils';
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

  const workflowOperations = createWorkflowOperations({ withDatabase });
  const workflowDraftOperations = createWorkflowDraftOperations({ withDatabase });
  const repositoryOperations = createRepositoryOperations({
    withDatabase,
    dependencies: {
      createScmProvider: dependencies.createScmProvider,
      ensureRepositoryClone: dependencies.ensureRepositoryClone,
    },
    environment,
  });
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

  return {
    ...workflowOperations,
    ...workflowDraftOperations,
    ...repositoryOperations,
    ...runOperations,
  };
}
