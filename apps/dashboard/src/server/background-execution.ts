import {
  type PhaseProviderResolver,
} from '@alphred/core';
import {
  runWorktrees,
  transitionWorkflowRunStatus,
  workflowRuns,
  type AlphredDatabase,
} from '@alphred/db';
import type { WorktreeManager } from '@alphred/git';
import { asc, eq } from 'drizzle-orm';
import { DashboardIntegrationError } from './dashboard-errors';
import {
  isWorkflowRunTransitionPreconditionError,
  toBackgroundFailureTransition,
  toErrorMessage,
  type RunStatus,
} from './dashboard-utils';

type WithDatabase = <T>(operation: (db: AlphredDatabase) => Promise<T> | T) => Promise<T>;

type BackgroundExecutionDependencies = {
  createSqlWorkflowExecutor: (
    db: AlphredDatabase,
    dependencies: {
      resolveProvider: PhaseProviderResolver;
    },
  ) => {
    executeRun: (params: {
      workflowRunId: number;
      options: {
        workingDirectory: string;
      };
    }) => Promise<{
      finalStep: {
        runStatus: string;
        outcome: string;
      };
      executedNodes: number;
    }>;
  };
  resolveProvider: PhaseProviderResolver;
  createWorktreeManager: (db: AlphredDatabase, environment: NodeJS.ProcessEnv) => Pick<WorktreeManager, 'cleanupRun'>;
};

const backgroundRunExecutions = new Map<number, Promise<void>>();

export type RunExecutionContext = {
  workingDirectory: string;
  hasManagedWorktree: boolean;
};

export type BackgroundExecutionManager = {
  executeWorkflowRun: (
    db: AlphredDatabase,
    runId: number,
    workingDirectory: string,
    worktreeManager: Pick<WorktreeManager, 'cleanupRun'> | null,
    cleanupWorktree: boolean,
  ) => Promise<{
    runStatus: RunStatus;
    executionOutcome: string;
    executedNodes: number;
  }>;
  markPendingRunCancelled: (db: AlphredDatabase, runId: number) => Promise<void>;
  resolveRunExecutionContext: (db: Pick<AlphredDatabase, 'select'>, runId: number) => RunExecutionContext;
  enqueueBackgroundRunExecution: (params: {
    runId: number;
    workingDirectory: string;
    hasManagedWorktree: boolean;
    cleanupWorktree: boolean;
  }) => boolean;
  ensureBackgroundRunExecution: (params: {
    runId: number;
    workingDirectory: string;
    hasManagedWorktree: boolean;
    cleanupWorktree: boolean;
  }) => void;
  getBackgroundExecutionCount: () => number;
  hasBackgroundExecution: (runId: number) => boolean;
};

export function createBackgroundExecutionManager(params: {
  withDatabase: WithDatabase;
  dependencies: BackgroundExecutionDependencies;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}): BackgroundExecutionManager {
  const { withDatabase, dependencies, environment, cwd } = params;
  const pendingBackgroundExecutionReschedules = new Set<number>();

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

    let execution: Awaited<ReturnType<typeof executor.executeRun>> | undefined;
    let executionError: unknown = null;
    try {
      execution = await executor.executeRun({
        workflowRunId: runId,
        options: {
          workingDirectory,
        },
      });
    } catch (error) {
      executionError = error;
    }

    let cleanupError: unknown = null;
    if (cleanupWorktree && worktreeManager) {
      try {
        await worktreeManager.cleanupRun(runId);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (executionError !== null) {
      throw executionError;
    }

    if (cleanupError !== null) {
      throw cleanupError;
    }

    if (execution === undefined) {
      throw new DashboardIntegrationError('internal_error', 'Dashboard execution did not produce a terminal result.', {
        status: 500,
      });
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
      if (!isWorkflowRunTransitionPreconditionError(error)) {
        throw error;
      }
    }
  }

  async function markRunTerminalAfterBackgroundFailure(runId: number, originalError: unknown): Promise<void> {
    console.error(`Run id=${runId} background execution failed: ${toErrorMessage(originalError)}`);

    try {
      await withDatabase(async db => {
        const run = db
          .select({
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId))
          .get();
        if (!run) {
          return;
        }

        const transition = toBackgroundFailureTransition(run.status as RunStatus);
        if (!transition) {
          return;
        }

        try {
          transitionWorkflowRunStatus(db, {
            workflowRunId: runId,
            expectedFrom: transition.expectedFrom,
            to: transition.to,
          });
        } catch (error) {
          if (!isWorkflowRunTransitionPreconditionError(error)) {
            throw error;
          }
        }
      });
    } catch (transitionError) {
      console.error(`Run id=${runId} background failure status update failed: ${toErrorMessage(transitionError)}`);
    }
  }

  function resolveRunExecutionContext(db: Pick<AlphredDatabase, 'select'>, runId: number): RunExecutionContext {
    const worktreeRows = db
      .select({
        path: runWorktrees.worktreePath,
        status: runWorktrees.status,
      })
      .from(runWorktrees)
      .where(eq(runWorktrees.workflowRunId, runId))
      .orderBy(asc(runWorktrees.createdAt), asc(runWorktrees.id))
      .all();

    const selectedWorktree = worktreeRows.filter(worktree => worktree.status === 'active').at(-1);
    if (!selectedWorktree) {
      return {
        workingDirectory: cwd,
        hasManagedWorktree: false,
      };
    }

    return {
      workingDirectory: selectedWorktree.path,
      hasManagedWorktree: true,
    };
  }

  function enqueueBackgroundRunExecution(params: {
    runId: number;
    workingDirectory: string;
    hasManagedWorktree: boolean;
    cleanupWorktree: boolean;
  }): boolean {
    if (backgroundRunExecutions.has(params.runId)) {
      return false;
    }

    const executionPromise = withDatabase(async backgroundDb => {
      const backgroundWorktreeManager = params.hasManagedWorktree
        ? dependencies.createWorktreeManager(backgroundDb, environment)
        : null;
      await executeWorkflowRun(
        backgroundDb,
        params.runId,
        params.workingDirectory,
        backgroundWorktreeManager,
        params.cleanupWorktree,
      );
    })
      .then(() => undefined)
      .catch(async (error: unknown) => {
        await markRunTerminalAfterBackgroundFailure(params.runId, error);
      })
      .finally(() => {
        if (backgroundRunExecutions.get(params.runId) === executionPromise) {
          backgroundRunExecutions.delete(params.runId);
        }
      });

    backgroundRunExecutions.set(params.runId, executionPromise);
    return true;
  }

  function scheduleBackgroundRunExecutionReschedule(params: {
    runId: number;
    cleanupWorktree: boolean;
  }): void {
    if (pendingBackgroundExecutionReschedules.has(params.runId)) {
      return;
    }

    const activeExecution = backgroundRunExecutions.get(params.runId);
    if (!activeExecution) {
      return;
    }

    pendingBackgroundExecutionReschedules.add(params.runId);

    void activeExecution.finally(() => {
      pendingBackgroundExecutionReschedules.delete(params.runId);

      void withDatabase(async db => {
        const run = db
          .select({
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, params.runId))
          .get();
        if (!run || run.status !== 'running') {
          return;
        }

        const executionContext = resolveRunExecutionContext(db, params.runId);
        enqueueBackgroundRunExecution({
          runId: params.runId,
          workingDirectory: executionContext.workingDirectory,
          hasManagedWorktree: executionContext.hasManagedWorktree,
          cleanupWorktree: params.cleanupWorktree,
        });
      }).catch((error: unknown) => {
        console.error(
          `Run id=${params.runId} background execution reschedule failed: ${toErrorMessage(error)}`,
        );
      });
    });
  }

  function ensureBackgroundRunExecution(params: {
    runId: number;
    workingDirectory: string;
    hasManagedWorktree: boolean;
    cleanupWorktree: boolean;
  }): void {
    const didEnqueue = enqueueBackgroundRunExecution(params);
    if (didEnqueue) {
      return;
    }

    scheduleBackgroundRunExecutionReschedule({
      runId: params.runId,
      cleanupWorktree: params.cleanupWorktree,
    });
  }

  return {
    executeWorkflowRun,
    markPendingRunCancelled,
    resolveRunExecutionContext,
    enqueueBackgroundRunExecution,
    ensureBackgroundRunExecution,
    getBackgroundExecutionCount: () => backgroundRunExecutions.size,
    hasBackgroundExecution: runId => backgroundRunExecutions.has(runId),
  };
}
