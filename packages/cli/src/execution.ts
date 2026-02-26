import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  getRepositoryByName,
  transitionWorkflowRunStatus,
  workflowRuns,
  type AlphredDatabase,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import { createSqlWorkflowPlanner } from '@alphred/core';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import {
  EXIT_NOT_FOUND,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
} from './constants.js';
import { hasErrorCode, toErrorMessage } from './io.js';
import {
  formatScmProviderLabel,
  resolveRunRepository,
  toScmProviderConfigForAuth,
} from './repository.js';
import type {
  CliDependencies,
  CliIo,
  DisplayRunNode,
  ExitCode,
  ResolvedRunRepository,
  RunExecutionSetup,
  RunExecutionSummary,
  RunRepositoryPreparation,
  RunWorktreeManager,
  ScmAuthPreflightMode,
} from './types.js';
import { orderedNodeStatuses } from './types.js';

export function resolveDatabasePath(io: CliIo): string {
  const configuredPath = io.env.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(io.cwd, configuredPath);
  }

  return resolve(io.cwd, 'alphred.db');
}

export function openInitializedDatabase(dependencies: CliDependencies, io: CliIo): AlphredDatabase {
  const db = dependencies.openDatabase(resolveDatabasePath(io));
  dependencies.migrateDatabase(db);
  return db;
}

export function shouldTreatRunStatusAsFailure(status: WorkflowRunStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

export function formatNodeStatusSummary(nodes: readonly DisplayRunNode[]): string {
  const countsByStatus = new Map<RunNodeStatus, number>(orderedNodeStatuses.map(status => [status, 0]));
  for (const node of nodes) {
    countsByStatus.set(node.status, (countsByStatus.get(node.status) ?? 0) + 1);
  }

  return orderedNodeStatuses
    .map(status => `${status}=${countsByStatus.get(status) ?? 0}`)
    .join(' ');
}

export function selectLatestAttempts(rows: readonly DisplayRunNode[]): DisplayRunNode[] {
  const latestByNodeKey = new Map<string, DisplayRunNode>();
  for (const row of rows) {
    const current = latestByNodeKey.get(row.nodeKey);
    if (!current || row.attempt > current.attempt || (row.attempt === current.attempt && row.id > current.id)) {
      latestByNodeKey.set(row.nodeKey, row);
    }
  }

  return [...latestByNodeKey.values()].sort((left, right) => {
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
  });
}

export async function runScmAuthPreflight(
  repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>,
  dependencies: Pick<CliDependencies, 'createScmProvider'>,
  io: Pick<CliIo, 'stderr' | 'env'>,
  options: {
    commandName: string;
    mode: ScmAuthPreflightMode;
  },
): Promise<ExitCode | null> {
  const providerLabel = formatScmProviderLabel(repository.provider);

  let authStatus: AuthStatus;
  try {
    const provider = dependencies.createScmProvider(toScmProviderConfigForAuth(repository));
    authStatus = await provider.checkAuth(io.env);
  } catch (error) {
    io.stderr(`Failed to verify ${providerLabel} authentication: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }

  if (authStatus.authenticated) {
    return null;
  }

  const remediationMessage = authStatus.error?.trim() || `${providerLabel} authentication is not configured.`;
  if (options.mode === 'warn') {
    io.stderr(`Warning: ${providerLabel} authentication is not configured. Continuing "${options.commandName}".`);
    io.stderr(remediationMessage);
    return null;
  }

  io.stderr(`Failed to execute ${options.commandName}: ${providerLabel} authentication is required.`);
  io.stderr(remediationMessage);
  return EXIT_RUNTIME_ERROR;
}

export function reportAutoRegisteredRepository(
  io: Pick<CliIo, 'stdout'>,
  repository: ResolvedRunRepository | null,
): void {
  if (!repository?.autoRegistered) {
    return;
  }

  io.stdout(`Auto-registered repository "${repository.repoName}" from ${repository.provider}:${repository.remoteRef}.`);
}

export function materializeRun(treeKey: string, db: AlphredDatabase, io: Pick<CliIo, 'stdout'>): number {
  const planner = createSqlWorkflowPlanner(db);
  const materializedRun = planner.materializeRun({ treeKey });
  const runId = materializedRun.run.id;
  io.stdout(`Started run id=${runId} for tree "${treeKey}".`);
  return runId;
}

export async function setupRunExecution(
  runId: number,
  treeKey: string,
  resolvedRepo: ResolvedRunRepository | null,
  branchOverride: string | undefined,
  worktreeManager: RunWorktreeManager | null,
  io: CliIo,
): Promise<RunExecutionSetup> {
  if (!resolvedRepo) {
    return {
      workingDirectory: io.cwd,
      worktreeManager: null,
    };
  }
  if (!worktreeManager) {
    throw new Error('Internal error: worktree manager was not initialized for repository-backed run.');
  }

  const worktree = await worktreeManager.createRunWorktree({
    repoName: resolvedRepo.repoName,
    treeKey,
    runId,
    branch: branchOverride,
  });
  io.stdout(`Created worktree "${worktree.path}" on branch "${worktree.branch}" for repo "${resolvedRepo.repoName}".`);
  return {
    workingDirectory: worktree.path,
    worktreeManager,
  };
}

export function summarizeRunExecution(execution: RunExecutionSummary, io: CliIo): ExitCode {
  io.stdout(
    `Run id=${execution.workflowRunId} outcome=${execution.finalStep.outcome} status=${execution.finalStep.runStatus} executed_nodes=${execution.executedNodes}.`,
  );

  if (shouldTreatRunStatusAsFailure(execution.finalStep.runStatus)) {
    io.stderr(`Run id=${execution.workflowRunId} finished with status=${execution.finalStep.runStatus}.`);
    return EXIT_RUNTIME_ERROR;
  }

  return EXIT_SUCCESS;
}

export function cancelPendingRunAfterSetupFailure(db: AlphredDatabase, runId: number, io: Pick<CliIo, 'stderr'>): void {
  try {
    const run = db
      .select({
        status: workflowRuns.status,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    if (run?.status === 'pending') {
      transitionWorkflowRunStatus(db, {
        workflowRunId: runId,
        expectedFrom: 'pending',
        to: 'cancelled',
      });
    }
  } catch (transitionError) {
    io.stderr(`Failed to cancel run id=${runId} after setup error: ${toErrorMessage(transitionError)}`);
  }
}

export function mapRunExecutionError(error: unknown, treeKey: string, io: Pick<CliIo, 'stderr'>): ExitCode {
  if (hasErrorCode(error, 'WORKFLOW_TREE_NOT_FOUND')) {
    io.stderr(`Workflow tree not found for key "${treeKey}".`);
    return EXIT_NOT_FOUND;
  }

  io.stderr(`Failed to execute run: ${toErrorMessage(error)}`);
  return EXIT_RUNTIME_ERROR;
}

export async function cleanupRunWorktrees(
  worktreeManager: RunWorktreeManager | null,
  runId: number | null,
  io: Pick<CliIo, 'stderr'>,
): Promise<ExitCode | null> {
  if (!worktreeManager || runId === null) {
    return null;
  }

  try {
    await worktreeManager.cleanupRun(runId);
    return null;
  } catch (error) {
    io.stderr(`Failed to clean up run worktrees for run id=${runId}: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

export async function prepareRunRepository(
  db: AlphredDatabase,
  repoInput: string | null,
  dependencies: CliDependencies,
  io: Pick<CliIo, 'stdout' | 'stderr' | 'env'>,
): Promise<RunRepositoryPreparation> {
  const resolvedRepo = repoInput ? resolveRunRepository(db, repoInput) : null;
  const runRepository = resolvedRepo ? getRepositoryByName(db, resolvedRepo.repoName) : null;
  if (resolvedRepo && !runRepository) {
    throw new Error(`Repository "${resolvedRepo.repoName}" was not found.`);
  }

  if (runRepository) {
    const authExitCode = await runScmAuthPreflight(runRepository, dependencies, io, {
      commandName: 'run --repo',
      mode: 'require',
    });
    if (authExitCode !== null) {
      return {
        resolvedRepo,
        worktreeManager: null,
        authExitCode,
      };
    }
  }

  reportAutoRegisteredRepository(io, resolvedRepo);
  return {
    resolvedRepo,
    worktreeManager: resolvedRepo
      ? dependencies.createWorktreeManager(db, {
          environment: io.env,
        })
      : null,
    authExitCode: null,
  };
}
