import { createSqlWorkflowExecutor } from '@alphred/core';
import type { AlphredDatabase } from '@alphred/db';
import { EXIT_SUCCESS } from '../constants.js';
import {
  cancelPendingRunAfterSetupFailure,
  cleanupRunWorktrees,
  mapRunExecutionError,
  materializeRun,
  openInitializedDatabase,
  prepareRunRepository,
  setupRunExecution,
  summarizeRunExecution,
} from '../execution.js';
import {
  isRunControlAction,
  parseRunCommandInput,
} from '../parsing.js';
import type {
  CliDependencies,
  CliIo,
  ExitCode,
  RunWorktreeManager,
} from '../types.js';
import { handleRunControlCommand } from './run-control.js';

export async function handleRunCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const runSubcommand = rawArgs[0];
  if (runSubcommand && isRunControlAction(runSubcommand)) {
    return handleRunControlCommand(runSubcommand, rawArgs.slice(1), dependencies, io);
  }

  const parsedInput = parseRunCommandInput(rawArgs, io);
  if (!parsedInput.ok) {
    return parsedInput.exitCode;
  }
  const { treeKey, repoInput, branchOverride } = parsedInput;

  let db: AlphredDatabase | null = null;
  let runId: number | null = null;
  let worktreeManager: RunWorktreeManager | null = null;
  let setupCompleted = false;
  let exitCode: ExitCode = EXIT_SUCCESS;

  try {
    db = openInitializedDatabase(dependencies, io);
    const runRepository = await prepareRunRepository(db, repoInput, dependencies, io);
    if (runRepository.authExitCode !== null) {
      return runRepository.authExitCode;
    }
    const { resolvedRepo } = runRepository;
    worktreeManager = runRepository.worktreeManager;

    runId = materializeRun(treeKey, db, io);
    const runSetup = await setupRunExecution(runId, treeKey, resolvedRepo, branchOverride, worktreeManager, io);
    worktreeManager = runSetup.worktreeManager;
    setupCompleted = true;

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: dependencies.resolveProvider,
    });

    const execution = await executor.executeRun({
      workflowRunId: runId,
      options: {
        workingDirectory: runSetup.workingDirectory,
      },
    });

    exitCode = summarizeRunExecution(execution, io);
  } catch (error) {
    if (db && runId !== null && !setupCompleted) {
      cancelPendingRunAfterSetupFailure(db, runId, io);
    }

    exitCode = mapRunExecutionError(error, treeKey, io);
  } finally {
    const cleanupExitCode = await cleanupRunWorktrees(worktreeManager, runId, io);
    if (cleanupExitCode !== null) {
      exitCode = cleanupExitCode;
    }
  }

  return exitCode;
}
