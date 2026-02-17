import { join, resolve } from 'node:path';
import { asc, desc, eq } from 'drizzle-orm';
import { resolveAgentProvider } from '@alphred/agents';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner, type PhaseProviderResolver } from '@alphred/core';
import {
  createDatabase,
  getRepositoryByName,
  listRepositories,
  listRunWorktreesForRun,
  migrateDatabase,
  phaseArtifacts,
  routingDecisions,
  runNodes,
  runWorktrees,
  transitionWorkflowRunStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
} from '@alphred/db';
import {
  WorktreeManager,
  createScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import type {
  DashboardArtifactSnapshot,
  DashboardGitHubAuthStatus,
  DashboardNodeStatus,
  DashboardNodeStatusSummary,
  DashboardRepositoryState,
  DashboardRepositorySyncResult,
  DashboardRoutingDecisionSnapshot,
  DashboardRunDetail,
  DashboardRunLaunchRequest,
  DashboardRunLaunchResult,
  DashboardRunNodeSnapshot,
  DashboardRunSummary,
  DashboardRunWorktreeMetadata,
  DashboardWorkflowTreeSummary,
} from './dashboard-contracts';
import { DashboardIntegrationError, toDashboardIntegrationError } from './dashboard-errors';

type RunStatus = DashboardRunSummary['status'];

const BACKGROUND_RUN_STATUS: RunStatus = 'running';
const DEFAULT_GITHUB_AUTH_REPO = 'octocat/Hello-World';
const MAX_ARTIFACT_PREVIEW_LENGTH = 280;
const RECENT_SNAPSHOT_LIMIT = 30;

const backgroundRunExecutions = new Map<number, Promise<void>>();

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

function resolveDatabasePath(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configuredPath = environment.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(cwd, configuredPath);
  }

  return resolve(cwd, 'alphred.db');
}

function summarizeNodeStatuses(nodes: readonly { status: DashboardNodeStatus }[]): DashboardNodeStatusSummary {
  const summary: DashboardNodeStatusSummary = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };

  for (const node of nodes) {
    summary[node.status] += 1;
  }

  return summary;
}

function selectLatestNodeAttempts(
  nodes: readonly {
    id: number;
    nodeKey: string;
    attempt: number;
    sequenceIndex: number;
    treeNodeId: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  }[],
): DashboardRunNodeSnapshot[] {
  const latestByNodeKey = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    const current = latestByNodeKey.get(node.nodeKey);
    if (!current || node.attempt > current.attempt || (node.attempt === current.attempt && node.id > current.id)) {
      latestByNodeKey.set(node.nodeKey, node);
    }
  }

  return [...latestByNodeKey.values()]
    .sort((left, right) => {
      if (left.sequenceIndex !== right.sequenceIndex) {
        return left.sequenceIndex - right.sequenceIndex;
      }
      if (left.nodeKey < right.nodeKey) {
        return -1;
      }
      if (left.nodeKey > right.nodeKey) {
        return 1;
      }
      return left.id - right.id;
    })
    .map(node => ({
      id: node.id,
      treeNodeId: node.treeNodeId,
      nodeKey: node.nodeKey,
      sequenceIndex: node.sequenceIndex,
      attempt: node.attempt,
      status: node.status as DashboardNodeStatus,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      latestArtifact: null,
      latestRoutingDecision: null,
    }));
}

function toRepositoryState(repository: RepositoryConfig): DashboardRepositoryState {
  return {
    id: repository.id,
    name: repository.name,
    provider: repository.provider,
    remoteRef: repository.remoteRef,
    remoteUrl: repository.remoteUrl,
    defaultBranch: repository.defaultBranch,
    branchTemplate: repository.branchTemplate,
    cloneStatus: repository.cloneStatus,
    localPath: repository.localPath,
  };
}

function createArtifactSnapshot(
  artifact: {
    id: number;
    runNodeId: number;
    artifactType: string;
    contentType: string;
    content: string;
    createdAt: string;
  },
): DashboardArtifactSnapshot {
  return {
    id: artifact.id,
    runNodeId: artifact.runNodeId,
    artifactType: artifact.artifactType as DashboardArtifactSnapshot['artifactType'],
    contentType: artifact.contentType as DashboardArtifactSnapshot['contentType'],
    contentPreview: artifact.content.slice(0, MAX_ARTIFACT_PREVIEW_LENGTH),
    createdAt: artifact.createdAt,
  };
}

function createRoutingDecisionSnapshot(
  decision: {
    id: number;
    runNodeId: number;
    decisionType: string;
    rationale: string | null;
    createdAt: string;
  },
): DashboardRoutingDecisionSnapshot {
  return {
    id: decision.id,
    runNodeId: decision.runNodeId,
    decisionType: decision.decisionType as DashboardRoutingDecisionSnapshot['decisionType'],
    rationale: decision.rationale,
    createdAt: decision.createdAt,
  };
}

function toWorktreeMetadata(worktree: {
  id: number;
  workflowRunId: number;
  repositoryId: number;
  worktreePath: string;
  branch: string;
  commitHash: string | null;
  status: string;
  createdAt: string;
  removedAt: string | null;
}): DashboardRunWorktreeMetadata {
  return {
    id: worktree.id,
    runId: worktree.workflowRunId,
    repositoryId: worktree.repositoryId,
    path: worktree.worktreePath,
    branch: worktree.branch,
    commitHash: worktree.commitHash,
    status: worktree.status as DashboardRunWorktreeMetadata['status'],
    createdAt: worktree.createdAt,
    removedAt: worktree.removedAt,
  };
}

function parseAzureRemoteRef(remoteRef: string): {
  organization: string;
  project: string;
  repository: string;
} {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 3) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Invalid Azure repository reference "${remoteRef}". Expected org/project/repository.`,
      { status: 400 },
    );
  }

  return {
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}

function toAuthScmProviderConfig(repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>): ScmProviderConfig {
  if (repository.provider === 'github') {
    return {
      kind: 'github',
      repo: repository.remoteRef,
    };
  }

  const parsed = parseAzureRemoteRef(repository.remoteRef);
  return {
    kind: 'azure-devops',
    organization: parsed.organization,
    project: parsed.project,
    repository: parsed.repository,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isPendingRunTransitionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('precondition failed');
}

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

  async function ensureRepositoryAuth(repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>): Promise<void> {
    const provider = dependencies.createScmProvider(toAuthScmProviderConfig(repository));
    const authStatus = await provider.checkAuth(environment);
    if (authStatus.authenticated) {
      return;
    }

    const providerLabel = repository.provider === 'github' ? 'GitHub' : 'Azure DevOps';
    throw new DashboardIntegrationError(
      'auth_required',
      authStatus.error?.trim() || `${providerLabel} authentication is required.`,
      {
        status: 401,
        details: {
          provider: repository.provider,
        },
      },
    );
  }

  async function loadRunSummary(db: AlphredDatabase, runId: number): Promise<DashboardRunSummary> {
    const run = db
      .select({
        id: workflowRuns.id,
        workflowTreeId: workflowRuns.workflowTreeId,
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
        createdAt: workflowRuns.createdAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    if (!run) {
      throw new DashboardIntegrationError('not_found', `Workflow run id=${runId} was not found.`, {
        status: 404,
      });
    }

    const tree = db
      .select({
        id: workflowTrees.id,
        treeKey: workflowTrees.treeKey,
        version: workflowTrees.version,
        name: workflowTrees.name,
      })
      .from(workflowTrees)
      .where(eq(workflowTrees.id, run.workflowTreeId))
      .get();

    if (!tree) {
      throw new DashboardIntegrationError(
        'internal_error',
        `Workflow tree id=${run.workflowTreeId} referenced by run id=${run.id} was not found.`,
        { status: 500 },
      );
    }

    const runNodeRows = db
      .select({
        id: runNodes.id,
        nodeKey: runNodes.nodeKey,
        attempt: runNodes.attempt,
        sequenceIndex: runNodes.sequenceIndex,
        treeNodeId: runNodes.treeNodeId,
        status: runNodes.status,
        startedAt: runNodes.startedAt,
        completedAt: runNodes.completedAt,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, run.id))
      .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
      .all();

    const latestNodes = selectLatestNodeAttempts(runNodeRows);

    return {
      id: run.id,
      tree,
      status: run.status as RunStatus,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
      nodeSummary: summarizeNodeStatuses(latestNodes),
    };
  }

  async function executeWorkflowRun(
    db: AlphredDatabase,
    runId: number,
    workingDirectory: string,
    worktreeManager: Pick<WorktreeManager, 'cleanupRun'> | null,
    cleanupWorktree: boolean,
  ): Promise<{
    runStatus: RunStatus;
    executionOutcome: string;
    executedNodes: number;
  }> {
    const executor = dependencies.createSqlWorkflowExecutor(db, {
      resolveProvider: dependencies.resolveProvider,
    });

    const execution = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory,
      },
    });

    if (cleanupWorktree && worktreeManager) {
      await worktreeManager.cleanupRun(runId);
    }

    return {
      runStatus: execution.finalStep.runStatus as RunStatus,
      executionOutcome: execution.finalStep.outcome,
      executedNodes: execution.executedNodes,
    };
  }

  async function markPendingRunCancelled(db: AlphredDatabase, runId: number): Promise<void> {
    try {
      transitionWorkflowRunStatus(db, {
        workflowRunId: runId,
        expectedFrom: 'pending',
        to: 'cancelled',
      });
    } catch (error) {
      if (!isPendingRunTransitionError(error)) {
        throw error;
      }
    }
  }

  return {
    listWorkflowTrees(): Promise<DashboardWorkflowTreeSummary[]> {
      return withDatabase(async db =>
        db
          .select({
            id: workflowTrees.id,
            treeKey: workflowTrees.treeKey,
            version: workflowTrees.version,
            name: workflowTrees.name,
            description: workflowTrees.description,
          })
          .from(workflowTrees)
          .orderBy(asc(workflowTrees.treeKey), desc(workflowTrees.version), desc(workflowTrees.id))
          .all()
      );
    },

    listRepositories(): Promise<DashboardRepositoryState[]> {
      return withDatabase(async db => listRepositories(db).map(toRepositoryState));
    },

    listWorkflowRuns(limit = 20): Promise<DashboardRunSummary[]> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Limit must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const runIds = db
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .orderBy(desc(workflowRuns.id))
          .limit(limit)
          .all();

        const summaries: DashboardRunSummary[] = [];
        for (const run of runIds) {
          summaries.push(await loadRunSummary(db, run.id));
        }

        return summaries;
      });
    },

    getWorkflowRunDetail(runId: number): Promise<DashboardRunDetail> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const summary = await loadRunSummary(db, runId);
        const runNodeRows = db
          .select({
            id: runNodes.id,
            nodeKey: runNodes.nodeKey,
            attempt: runNodes.attempt,
            sequenceIndex: runNodes.sequenceIndex,
            treeNodeId: runNodes.treeNodeId,
            status: runNodes.status,
            startedAt: runNodes.startedAt,
            completedAt: runNodes.completedAt,
          })
          .from(runNodes)
          .where(eq(runNodes.workflowRunId, runId))
          .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.id))
          .all();

        const latestNodes = selectLatestNodeAttempts(runNodeRows);

        const recentArtifacts = db
          .select({
            id: phaseArtifacts.id,
            runNodeId: phaseArtifacts.runNodeId,
            artifactType: phaseArtifacts.artifactType,
            contentType: phaseArtifacts.contentType,
            content: phaseArtifacts.content,
            createdAt: phaseArtifacts.createdAt,
          })
          .from(phaseArtifacts)
          .where(eq(phaseArtifacts.workflowRunId, runId))
          .orderBy(desc(phaseArtifacts.createdAt), desc(phaseArtifacts.id))
          .limit(RECENT_SNAPSHOT_LIMIT)
          .all();

        const recentDecisions = db
          .select({
            id: routingDecisions.id,
            runNodeId: routingDecisions.runNodeId,
            decisionType: routingDecisions.decisionType,
            rationale: routingDecisions.rationale,
            createdAt: routingDecisions.createdAt,
          })
          .from(routingDecisions)
          .where(eq(routingDecisions.workflowRunId, runId))
          .orderBy(desc(routingDecisions.createdAt), desc(routingDecisions.id))
          .limit(RECENT_SNAPSHOT_LIMIT)
          .all();

        const latestArtifactByRunNodeId = new Map<number, DashboardArtifactSnapshot>();
        for (const artifact of recentArtifacts) {
          if (!latestArtifactByRunNodeId.has(artifact.runNodeId)) {
            latestArtifactByRunNodeId.set(artifact.runNodeId, createArtifactSnapshot(artifact));
          }
        }

        const latestDecisionByRunNodeId = new Map<number, DashboardRoutingDecisionSnapshot>();
        for (const decision of recentDecisions) {
          if (!latestDecisionByRunNodeId.has(decision.runNodeId)) {
            latestDecisionByRunNodeId.set(decision.runNodeId, createRoutingDecisionSnapshot(decision));
          }
        }

        const nodes: DashboardRunNodeSnapshot[] = latestNodes.map(node => ({
          ...node,
          latestArtifact: latestArtifactByRunNodeId.get(node.id) ?? null,
          latestRoutingDecision: latestDecisionByRunNodeId.get(node.id) ?? null,
        }));

        const allRunWorktrees = db
          .select({
            id: runWorktrees.id,
            workflowRunId: runWorktrees.workflowRunId,
            repositoryId: runWorktrees.repositoryId,
            worktreePath: runWorktrees.worktreePath,
            branch: runWorktrees.branch,
            commitHash: runWorktrees.commitHash,
            status: runWorktrees.status,
            createdAt: runWorktrees.createdAt,
            removedAt: runWorktrees.removedAt,
          })
          .from(runWorktrees)
          .where(eq(runWorktrees.workflowRunId, runId))
          .orderBy(asc(runWorktrees.createdAt), asc(runWorktrees.id))
          .all();

        return {
          run: summary,
          nodes,
          artifacts: recentArtifacts.map(createArtifactSnapshot),
          routingDecisions: recentDecisions.map(createRoutingDecisionSnapshot),
          worktrees: allRunWorktrees.map(toWorktreeMetadata),
        };
      });
    },

    getRunWorktrees(runId: number): Promise<DashboardRunWorktreeMetadata[]> {
      if (!Number.isInteger(runId) || runId < 1) {
        throw new DashboardIntegrationError('invalid_request', 'Run id must be a positive integer.', {
          status: 400,
        });
      }

      return withDatabase(async db => listRunWorktreesForRun(db, runId).map(toWorktreeMetadata));
    },

    checkGitHubAuth(): Promise<DashboardGitHubAuthStatus> {
      return withDatabase(async db => {
        const githubRepo = listRepositories(db).find(repository => repository.provider === 'github');
        const provider = dependencies.createScmProvider({
          kind: 'github',
          repo: githubRepo?.remoteRef ?? environment.ALPHRED_DASHBOARD_GITHUB_AUTH_REPO ?? DEFAULT_GITHUB_AUTH_REPO,
        });
        const auth = await provider.checkAuth(environment);

        return {
          authenticated: auth.authenticated,
          user: auth.user ?? null,
          scopes: auth.scopes ?? [],
          error: auth.error ?? null,
        };
      });
    },

    syncRepository(repositoryName: string): Promise<DashboardRepositorySyncResult> {
      const trimmedRepositoryName = repositoryName.trim();
      if (trimmedRepositoryName.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'Repository name cannot be empty.', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const repository = getRepositoryByName(db, trimmedRepositoryName);
        if (!repository) {
          throw new DashboardIntegrationError('not_found', `Repository "${trimmedRepositoryName}" was not found.`, {
            status: 404,
          });
        }

        await ensureRepositoryAuth(repository);

        const cloned = await dependencies.ensureRepositoryClone({
          db,
          repository: {
            name: repository.name,
            provider: repository.provider,
            remoteUrl: repository.remoteUrl,
            remoteRef: repository.remoteRef,
            defaultBranch: repository.defaultBranch,
          },
          environment,
        });

        return {
          action: cloned.action,
          repository: toRepositoryState(cloned.repository),
        };
      });
    },

    launchWorkflowRun(request: DashboardRunLaunchRequest): Promise<DashboardRunLaunchResult> {
      const treeKey = request.treeKey.trim();
      if (treeKey.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'treeKey cannot be empty.', {
          status: 400,
        });
      }

      const repositoryName = request.repositoryName?.trim();
      if (request.repositoryName !== undefined && repositoryName?.length === 0) {
        throw new DashboardIntegrationError('invalid_request', 'repositoryName cannot be empty when provided.', {
          status: 400,
        });
      }

      const executionMode = request.executionMode ?? 'async';
      if (executionMode !== 'async' && executionMode !== 'sync') {
        throw new DashboardIntegrationError('invalid_request', 'executionMode must be "async" or "sync".', {
          status: 400,
        });
      }

      return withDatabase(async db => {
        const planner = dependencies.createSqlWorkflowPlanner(db);
        const materializedRun = planner.materializeRun({ treeKey });

        const workflowRunId = materializedRun.run.id;
        const runId = workflowRunId;
        let workingDirectory = cwd;
        let worktreeManager: Pick<WorktreeManager, 'createRunWorktree' | 'cleanupRun'> | null = null;

        try {
          if (repositoryName !== undefined) {
            const repository = getRepositoryByName(db, repositoryName);
            if (!repository) {
              throw new DashboardIntegrationError(
                'not_found',
                `Repository "${repositoryName}" was not found.`,
                { status: 404 },
              );
            }

            await ensureRepositoryAuth(repository);

            worktreeManager = dependencies.createWorktreeManager(db, environment);
            const createdWorktree = await worktreeManager.createRunWorktree({
              repoName: repository.name,
              treeKey,
              runId,
              branch: request.branch?.trim() || undefined,
            });
            workingDirectory = createdWorktree.path;
          }

          if (executionMode === 'sync') {
            const execution = await executeWorkflowRun(
              db,
              runId,
              workingDirectory,
              worktreeManager,
              request.cleanupWorktree ?? false,
            );

            return {
              workflowRunId,
              mode: 'sync',
              status: 'completed',
              runStatus: execution.runStatus,
              executionOutcome: execution.executionOutcome,
              executedNodes: execution.executedNodes,
            };
          }

          const executionPromise = withDatabase(async backgroundDb => {
            const backgroundWorktreeManager = worktreeManager
              ? dependencies.createWorktreeManager(backgroundDb, environment)
              : null;
            await executeWorkflowRun(
              backgroundDb,
              runId,
              workingDirectory,
              backgroundWorktreeManager,
              request.cleanupWorktree ?? false,
            );
          })
            .then(() => undefined)
            .catch((error: unknown) => {
              console.error(`Run id=${runId} background execution failed: ${toErrorMessage(error)}`);
            })
            .finally(() => {
              backgroundRunExecutions.delete(runId);
            });

          backgroundRunExecutions.set(runId, executionPromise);

          return {
            workflowRunId,
            mode: 'async',
            status: 'accepted',
            runStatus: BACKGROUND_RUN_STATUS,
            executionOutcome: null,
            executedNodes: null,
          };
        } catch (error) {
          await markPendingRunCancelled(db, workflowRunId);
          throw error;
        }
      });
    },

    getBackgroundExecutionCount(): number {
      return backgroundRunExecutions.size;
    },

    hasBackgroundExecution(runId: number): boolean {
      return backgroundRunExecutions.has(runId);
    },
  };
}
