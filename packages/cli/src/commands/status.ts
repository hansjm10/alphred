import { eq } from 'drizzle-orm';
import {
  runNodes,
  workflowRuns,
  workflowTrees,
  type RunNodeStatus,
} from '@alphred/db';
import {
  EXIT_NOT_FOUND,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  STATUS_USAGE,
} from '../constants.js';
import {
  formatNodeStatusSummary,
  openInitializedDatabase,
  selectLatestAttempts,
} from '../execution.js';
import { toErrorMessage } from '../io.js';
import {
  getRequiredOption,
  parseStrictPositiveInteger,
  validateCommandOptions,
} from '../parsing.js';
import type { CliDependencies, CliIo, ExitCode } from '../types.js';

export async function handleStatusCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'status',
      usage: STATUS_USAGE,
      allowedOptions: ['run'],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const runIdRaw = getRequiredOption(parsedOptions.options, 'run', 'run_id', STATUS_USAGE, io);
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

    const runRow = db
      .select({
        id: workflowRuns.id,
        workflowTreeId: workflowRuns.workflowTreeId,
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();

    if (!runRow) {
      io.stderr(`Workflow run id=${runId} was not found.`);
      return EXIT_NOT_FOUND;
    }

    const treeRow = db
      .select({
        id: workflowTrees.id,
        treeKey: workflowTrees.treeKey,
        treeVersion: workflowTrees.version,
      })
      .from(workflowTrees)
      .where(eq(workflowTrees.id, runRow.workflowTreeId))
      .get();

    if (!treeRow) {
      io.stderr(`Workflow tree id=${runRow.workflowTreeId} referenced by run id=${runId} was not found.`);
      return EXIT_RUNTIME_ERROR;
    }

    const latestNodes = selectLatestAttempts(
      db
        .select({
          id: runNodes.id,
          nodeKey: runNodes.nodeKey,
          status: runNodes.status,
          attempt: runNodes.attempt,
          sequenceIndex: runNodes.sequenceIndex,
        })
        .from(runNodes)
        .where(eq(runNodes.workflowRunId, runId))
        .all()
        .map(node => ({
          id: node.id,
          nodeKey: node.nodeKey,
          status: node.status as RunNodeStatus,
          attempt: node.attempt,
          sequenceIndex: node.sequenceIndex,
        })),
    );

    io.stdout(`Run id=${runRow.id} tree=${treeRow.treeKey}@${treeRow.treeVersion} status=${runRow.status}`);
    io.stdout(`Started at: ${runRow.startedAt ?? '(not started)'}`);
    io.stdout(`Completed at: ${runRow.completedAt ?? '(not completed)'}`);
    io.stdout(`Node status summary: ${formatNodeStatusSummary(latestNodes)}`);

    if (latestNodes.length === 0) {
      io.stdout('Node details: (no run nodes materialized)');
      return EXIT_SUCCESS;
    }

    io.stdout('Node details:');
    for (const node of latestNodes) {
      io.stdout(`  ${node.nodeKey}: status=${node.status} attempt=${node.attempt}`);
    }

    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to read run status: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}
