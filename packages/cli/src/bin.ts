#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { resolveAgentProvider } from '@alphred/agents';
import {
  createDatabase,
  migrateDatabase,
  runNodes,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import { createSqlWorkflowExecutor, createSqlWorkflowPlanner, type PhaseProviderResolver } from '@alphred/core';

const EXIT_SUCCESS = 0;
const EXIT_USAGE_ERROR = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_RUNTIME_ERROR = 4;

type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_USAGE_ERROR
  | typeof EXIT_NOT_FOUND
  | typeof EXIT_RUNTIME_ERROR;

type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CliDependencies = {
  openDatabase: (path: string) => AlphredDatabase;
  migrateDatabase: (db: AlphredDatabase) => void;
  resolveProvider: PhaseProviderResolver;
};

type MainOptions = {
  dependencies?: CliDependencies;
  io?: CliIo;
};

type ParsedOptions =
  | {
      ok: true;
      options: Map<string, string>;
      positionals: string[];
    }
  | {
      ok: false;
      message: string;
    };

type DisplayRunNode = {
  id: number;
  nodeKey: string;
  status: RunNodeStatus;
  attempt: number;
  sequenceIndex: number;
};

const orderedNodeStatuses: readonly RunNodeStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

const defaultDependencies: CliDependencies = {
  openDatabase: path => createDatabase(path),
  migrateDatabase: db => migrateDatabase(db),
  resolveProvider: providerName => resolveAgentProvider(providerName),
};

function createDefaultIo(): CliIo {
  return {
    stdout: message => console.log(message),
    stderr: message => console.error(message),
    cwd: process.cwd(),
    env: process.env,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === expectedCode
  );
}

function printGeneralUsage(io: Pick<CliIo, 'stdout'>): void {
  io.stdout('Alphred - LLM Agent Orchestrator');
  io.stdout('');
  io.stdout('Usage: alphred <command> [options]');
  io.stdout('');
  io.stdout('Commands:');
  io.stdout('  run --tree <tree_key>    Start and execute a workflow run');
  io.stdout('  status --run <run_id>    Show workflow run and node status');
  io.stdout('  list                     List available workflows (not implemented)');
}

function parseLongOptions(args: readonly string[]): ParsedOptions {
  const options = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (arg === '--') {
      for (let remainingIndex = index + 1; remainingIndex < args.length; remainingIndex += 1) {
        positionals.push(args[remainingIndex]);
      }
      break;
    }

    const equalsIndex = arg.indexOf('=');
    const hasInlineValue = equalsIndex >= 0;
    const optionName = hasInlineValue ? arg.slice(2, equalsIndex) : arg.slice(2);
    if (optionName.length === 0) {
      return {
        ok: false,
        message: 'Option name cannot be empty.',
      };
    }

    if (options.has(optionName)) {
      return {
        ok: false,
        message: `Option "--${optionName}" cannot be provided more than once.`,
      };
    }

    if (hasInlineValue) {
      const optionValue = arg.slice(equalsIndex + 1);
      if (optionValue.length === 0) {
        return {
          ok: false,
          message: `Option "--${optionName}" requires a value.`,
        };
      }
      options.set(optionName, optionValue);
      continue;
    }

    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith('--')) {
      return {
        ok: false,
        message: `Option "--${optionName}" requires a value.`,
      };
    }
    options.set(optionName, optionValue);
    index += 1;
  }

  return {
    ok: true,
    options,
    positionals,
  };
}

function parseStrictPositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}

function resolveDatabasePath(io: CliIo): string {
  const configuredPath = io.env.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(io.cwd, configuredPath);
  }

  return resolve(io.cwd, 'alphred.db');
}

function openInitializedDatabase(dependencies: CliDependencies, io: CliIo): AlphredDatabase {
  const db = dependencies.openDatabase(resolveDatabasePath(io));
  dependencies.migrateDatabase(db);
  return db;
}

function shouldTreatRunStatusAsFailure(status: WorkflowRunStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

function formatNodeStatusSummary(nodes: readonly DisplayRunNode[]): string {
  const countsByStatus = new Map<RunNodeStatus, number>(orderedNodeStatuses.map(status => [status, 0]));
  for (const node of nodes) {
    countsByStatus.set(node.status, (countsByStatus.get(node.status) ?? 0) + 1);
  }

  return orderedNodeStatuses
    .map(status => `${status}=${countsByStatus.get(status) ?? 0}`)
    .join(' ');
}

function selectLatestAttempts(rows: readonly DisplayRunNode[]): DisplayRunNode[] {
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

async function handleRunCommand(rawArgs: readonly string[], dependencies: CliDependencies, io: CliIo): Promise<ExitCode> {
  const parsedOptions = parseLongOptions(rawArgs);
  if (!parsedOptions.ok) {
    io.stderr(parsedOptions.message);
    io.stderr('Usage: alphred run --tree <tree_key>');
    return EXIT_USAGE_ERROR;
  }

  const { options, positionals } = parsedOptions;
  if (positionals.length > 0) {
    io.stderr(`Unexpected positional arguments for "run": ${positionals.join(' ')}`);
    io.stderr('Usage: alphred run --tree <tree_key>');
    return EXIT_USAGE_ERROR;
  }

  for (const optionName of options.keys()) {
    if (optionName !== 'tree') {
      io.stderr(`Unknown option for "run": --${optionName}`);
      io.stderr('Usage: alphred run --tree <tree_key>');
      return EXIT_USAGE_ERROR;
    }
  }

  const treeKey = options.get('tree');
  if (!treeKey) {
    io.stderr('Missing required option: --tree <tree_key>');
    io.stderr('Usage: alphred run --tree <tree_key>');
    return EXIT_USAGE_ERROR;
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const planner = createSqlWorkflowPlanner(db);
    const materializedRun = planner.materializeRun({ treeKey });
    io.stdout(`Started run id=${materializedRun.run.id} for tree "${treeKey}".`);

    const executor = createSqlWorkflowExecutor(db, {
      resolveProvider: dependencies.resolveProvider,
    });

    const execution = await executor.executeRun({
      workflowRunId: materializedRun.run.id,
      options: {
        workingDirectory: io.cwd,
      },
    });

    io.stdout(
      `Run id=${execution.workflowRunId} outcome=${execution.finalStep.outcome} status=${execution.finalStep.runStatus} executed_nodes=${execution.executedNodes}.`,
    );

    if (shouldTreatRunStatusAsFailure(execution.finalStep.runStatus)) {
      io.stderr(`Run id=${execution.workflowRunId} finished with status=${execution.finalStep.runStatus}.`);
      return EXIT_RUNTIME_ERROR;
    }

    return EXIT_SUCCESS;
  } catch (error) {
    if (hasErrorCode(error, 'WORKFLOW_TREE_NOT_FOUND')) {
      io.stderr(`Workflow tree not found for key "${treeKey}".`);
      return EXIT_NOT_FOUND;
    }

    io.stderr(`Failed to execute run: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleStatusCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = parseLongOptions(rawArgs);
  if (!parsedOptions.ok) {
    io.stderr(parsedOptions.message);
    io.stderr('Usage: alphred status --run <run_id>');
    return EXIT_USAGE_ERROR;
  }

  const { options, positionals } = parsedOptions;
  if (positionals.length > 0) {
    io.stderr(`Unexpected positional arguments for "status": ${positionals.join(' ')}`);
    io.stderr('Usage: alphred status --run <run_id>');
    return EXIT_USAGE_ERROR;
  }

  for (const optionName of options.keys()) {
    if (optionName !== 'run') {
      io.stderr(`Unknown option for "status": --${optionName}`);
      io.stderr('Usage: alphred status --run <run_id>');
      return EXIT_USAGE_ERROR;
    }
  }

  const runIdRaw = options.get('run');
  if (!runIdRaw) {
    io.stderr('Missing required option: --run <run_id>');
    io.stderr('Usage: alphred status --run <run_id>');
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

async function handleListCommand(_rawArgs: readonly string[], io: Pick<CliIo, 'stderr'>): Promise<ExitCode> {
  io.stderr('The "list" command is not implemented yet.');
  return EXIT_RUNTIME_ERROR;
}

function isExecutedAsScript(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return fileURLToPath(import.meta.url) === resolve(entrypoint);
}

export async function main(args: string[] = process.argv.slice(2), options: MainOptions = {}): Promise<ExitCode> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const io = options.io ?? createDefaultIo();
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printGeneralUsage(io);
    return EXIT_SUCCESS;
  }

  switch (command) {
    case 'run':
      return handleRunCommand(args.slice(1), dependencies, io);
    case 'status':
      return handleStatusCommand(args.slice(1), dependencies, io);
    case 'list':
      return handleListCommand(args.slice(1), io);
    default:
      io.stderr(`Unknown command "${command}".`);
      printGeneralUsage({ stdout: io.stderr });
      return EXIT_USAGE_ERROR;
  }
}

if (isExecutedAsScript()) {
  main().then(exitCode => {
    if (exitCode !== EXIT_SUCCESS) {
      process.exit(exitCode);
    }
  }).catch((error: unknown) => {
    console.error(`Fatal error: ${toErrorMessage(error)}`);
    process.exit(EXIT_RUNTIME_ERROR);
  });
}
