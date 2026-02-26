import {
  WorkflowRunControlError,
  createSqlWorkflowExecutor,
  type WorkflowRunControlAction,
} from '@alphred/core';
import {
  EXIT_NOT_FOUND,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from '../constants.js';
import { openInitializedDatabase } from '../execution.js';
import { isWorkflowRunNotFoundError, toErrorMessage } from '../io.js';
import {
  getRequiredOption,
  getRunControlUsage,
  parseStrictPositiveInteger,
  validateCommandOptions,
} from '../parsing.js';
import type { CliDependencies, CliIo, ExitCode } from '../types.js';

export async function handleRunControlCommand(
  action: WorkflowRunControlAction,
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const usage = getRunControlUsage(action);
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: `run ${action}`,
      usage,
      allowedOptions: ['run'],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const runIdRaw = getRequiredOption(parsedOptions.options, 'run', 'run_id', usage, io);
  if (!runIdRaw) {
    return EXIT_USAGE_ERROR;
  }

  const runId = parseStrictPositiveInteger(runIdRaw);
  if (runId === null) {
    io.stderr(`Invalid run id "${runIdRaw}". Run id must be a positive integer.`);
    return EXIT_USAGE_ERROR;
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: dependencies.resolveProvider,
    });

    let result;
    switch (action) {
      case 'cancel':
        result = await executor.cancelRun({ workflowRunId: runId });
        break;
      case 'pause':
        result = await executor.pauseRun({ workflowRunId: runId });
        break;
      case 'resume':
        result = await executor.resumeRun({ workflowRunId: runId });
        break;
      case 'retry':
        result = await executor.retryRun({ workflowRunId: runId });
        break;
    }

    io.stdout(JSON.stringify(result));
    return EXIT_SUCCESS;
  } catch (error) {
    if (error instanceof WorkflowRunControlError) {
      io.stderr(error.message);
      io.stderr(`Control failure: code=${error.code} action=${error.action} runStatus=${error.runStatus}.`);
      return EXIT_RUNTIME_ERROR;
    }

    if (isWorkflowRunNotFoundError(error)) {
      io.stderr(toErrorMessage(error));
      return EXIT_NOT_FOUND;
    }

    io.stderr(`Failed to apply ${action} control for run id=${runId}: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}
