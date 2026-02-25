#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { resolveAgentProvider } from '@alphred/agents';
import {
  createDatabase,
  getRepositoryByName,
  insertRepository,
  listRepositories,
  migrateDatabase,
  repositories,
  runNodes,
  runWorktrees,
  transitionWorkflowRunStatus,
  workflowRuns,
  workflowTrees,
  type AlphredDatabase,
  type InsertRepositoryParams,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import {
  WorkflowRunControlError,
  createSqlWorkflowExecutor,
  createSqlWorkflowPlanner,
  type PhaseProviderResolver,
  type WorkflowRunControlAction,
} from '@alphred/core';
import {
  WorktreeManager,
  createScmProvider as createGitScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';

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
  createScmProvider: (config: ScmProviderConfig) => {
    checkAuth: (environment?: NodeJS.ProcessEnv) => Promise<AuthStatus>;
  };
  ensureRepositoryClone: typeof ensureRepositoryClone;
  createWorktreeManager: (db: AlphredDatabase, options: { environment: NodeJS.ProcessEnv }) => Pick<
    WorktreeManager,
    'createRunWorktree' | 'cleanupRun'
  >;
  removeDirectory: (path: string) => Promise<void>;
};

type MainOptions = {
  dependencies?: CliDependencies;
  io?: CliIo;
};

export type CliEntrypointRuntime = {
  argv: string[];
  exit: (code: number) => void;
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

type ParsedLongOptionToken =
  | {
      kind: 'positional';
      value: string;
    }
  | {
      kind: 'separator';
    }
  | {
      kind: 'option-inline';
      optionName: string;
      optionValue: string;
    }
  | {
      kind: 'option-next';
      optionName: string;
    }
  | {
      kind: 'flag';
      optionName: string;
    }
  | {
      kind: 'error';
      message: string;
    };

type ValidatedCommandOptions =
  | {
      ok: true;
      options: Map<string, string>;
      positionals: string[];
    }
  | {
      ok: false;
      exitCode: ExitCode;
    };

type CommandValidationConfig = {
  commandName: string;
  usage: string;
  allowedOptions: readonly string[];
  flagOptions?: readonly string[];
  positionalCount?: number;
};

type ResolvedRunRepository =
  | {
      repoName: string;
      autoRegistered: false;
    }
  | {
      repoName: string;
      autoRegistered: true;
      provider: RepositoryConfig['provider'];
      remoteRef: string;
    };

type RunWorktreeManager = ReturnType<CliDependencies['createWorktreeManager']>;

type ParsedRunCommandInput =
  | {
      ok: true;
      treeKey: string;
      repoInput: string | null;
      branchOverride: string | undefined;
    }
  | {
      ok: false;
      exitCode: ExitCode;
    };

type RunExecutionSetup = {
  workingDirectory: string;
  worktreeManager: RunWorktreeManager | null;
};

type RunRepositoryPreparation = {
  resolvedRepo: ResolvedRunRepository | null;
  worktreeManager: RunWorktreeManager | null;
  authExitCode: ExitCode | null;
};

type RunExecutionSummary = {
  workflowRunId: number;
  finalStep: {
    outcome: string;
    runStatus: WorkflowRunStatus;
  };
  executedNodes: number;
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
  createScmProvider: config => createGitScmProvider(config),
  ensureRepositoryClone: params => ensureRepositoryClone(params),
  createWorktreeManager: (db, options) =>
    new WorktreeManager(db, {
      worktreeBase: join(resolveSandboxDir(options.environment), 'worktrees'),
      environment: options.environment,
    }),
  removeDirectory: path => rm(path, { recursive: true, force: true }),
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

function isWorkflowRunNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Workflow run id=\d+ was not found\.$/.test(error.message);
}

function printGeneralUsage(io: Pick<CliIo, 'stdout'>): void {
  io.stdout('Alphred - LLM Agent Orchestrator');
  io.stdout('');
  io.stdout('Usage: alphred <command> [options]');
  io.stdout('');
  io.stdout('Commands:');
  io.stdout('  run --tree <tree_key> [--repo <name|github:owner/repo|azure:org/project/repo>] [--branch <name>]');
  io.stdout('                             Start and execute a workflow run');
  io.stdout('  run <cancel|pause|resume|retry> --run <run_id>');
  io.stdout('                             Control lifecycle state for an existing run');
  io.stdout('  status --run <run_id>      Show workflow run and node status');
  io.stdout('  repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)');
  io.stdout('                             Register a managed repository');
  io.stdout('  repo list                  List registered repositories');
  io.stdout('  repo show <name>           Show repository details');
  io.stdout('  repo remove <name> [--purge]');
  io.stdout('                             Remove repository and optionally local clone');
  io.stdout('  repo sync <name>           Clone or fetch repository into sandbox');
  io.stdout('  list                     List available workflows (not implemented)');
}

function usageError(io: Pick<CliIo, 'stderr'>, message: string, usage: string): ExitCode {
  io.stderr(message);
  io.stderr(usage);
  return EXIT_USAGE_ERROR;
}

function parseLongOptionToken(arg: string, flagOptions: ReadonlySet<string>): ParsedLongOptionToken {
  if (!arg.startsWith('--')) {
    return {
      kind: 'positional',
      value: arg,
    };
  }

  if (arg === '--') {
    return {
      kind: 'separator',
    };
  }

  const equalsIndex = arg.indexOf('=');
  const hasInlineValue = equalsIndex >= 0;
  const optionName = hasInlineValue ? arg.slice(2, equalsIndex) : arg.slice(2);
  if (optionName.length === 0) {
    return {
      kind: 'error',
      message: 'Option name cannot be empty.',
    };
  }

  if (!hasInlineValue) {
    if (flagOptions.has(optionName)) {
      return {
        kind: 'flag',
        optionName,
      };
    }

    return {
      kind: 'option-next',
      optionName,
    };
  }

  const optionValue = arg.slice(equalsIndex + 1);
  if (optionValue.length === 0) {
    return {
      kind: 'error',
      message: `Option "--${optionName}" requires a value.`,
    };
  }

  return {
    kind: 'option-inline',
    optionName,
    optionValue,
  };
}

function parseLongOptions(
  args: readonly string[],
  parseOptions: {
    flagOptions?: readonly string[];
  } = {},
): ParsedOptions {
  const flagOptions = new Set(parseOptions.flagOptions ?? []);
  const resolvedOptions = new Map<string, string>();
  const positionals: string[] = [];

  let cursor = 0;
  while (cursor < args.length) {
    const parsedToken = parseLongOptionToken(args[cursor], flagOptions);
    if (parsedToken.kind === 'error') {
      return {
        ok: false,
        message: parsedToken.message,
      };
    }

    if (parsedToken.kind === 'separator') {
      positionals.push(...args.slice(cursor + 1));
      break;
    }

    if (parsedToken.kind === 'positional') {
      positionals.push(parsedToken.value);
      cursor += 1;
      continue;
    }

    const { optionName } = parsedToken;
    if (resolvedOptions.has(optionName)) {
      return {
        ok: false,
        message: `Option "--${optionName}" cannot be provided more than once.`,
      };
    }

    if (parsedToken.kind === 'option-inline') {
      resolvedOptions.set(optionName, parsedToken.optionValue);
      cursor += 1;
      continue;
    }

    if (parsedToken.kind === 'flag') {
      resolvedOptions.set(optionName, 'true');
      cursor += 1;
      continue;
    }

    const optionValue = args[cursor + 1];
    if (!optionValue || optionValue.startsWith('--')) {
      return {
        ok: false,
        message: `Option "--${optionName}" requires a value.`,
      };
    }

    resolvedOptions.set(optionName, optionValue);
    cursor += 2;
  }

  return {
    ok: true,
    options: resolvedOptions,
    positionals,
  };
}

function validateCommandOptions(
  rawArgs: readonly string[],
  config: CommandValidationConfig,
  io: Pick<CliIo, 'stderr'>,
): ValidatedCommandOptions {
  const parsedOptions = parseLongOptions(rawArgs, {
    flagOptions: config.flagOptions,
  });
  if (!parsedOptions.ok) {
    return {
      ok: false,
      exitCode: usageError(io, parsedOptions.message, config.usage),
    };
  }

  const { options, positionals } = parsedOptions;
  const expectedPositionals = config.positionalCount ?? 0;
  if (positionals.length > expectedPositionals) {
    return {
      ok: false,
      exitCode: usageError(
        io,
        `Unexpected positional arguments for "${config.commandName}": ${positionals.join(' ')}`,
        config.usage,
      ),
    };
  }
  if (positionals.length < expectedPositionals) {
    return {
      ok: false,
      exitCode: usageError(
        io,
        `Missing required positional argument for "${config.commandName}".`,
        config.usage,
      ),
    };
  }

  const allowedOptions = new Set(config.allowedOptions);
  for (const optionName of options.keys()) {
    if (allowedOptions.has(optionName)) {
      continue;
    }
    return {
      ok: false,
      exitCode: usageError(io, `Unknown option for "${config.commandName}": --${optionName}`, config.usage),
    };
  }

  return {
    ok: true,
    options,
    positionals,
  };
}

function getRequiredOption(
  options: ReadonlyMap<string, string>,
  optionName: string,
  optionDescription: string,
  usage: string,
  io: Pick<CliIo, 'stderr'>,
): string | null {
  const value = options.get(optionName);
  if (value) {
    return value;
  }

  usageError(io, `Missing required option: --${optionName} <${optionDescription}>`, usage);
  return null;
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

const RUN_USAGE = 'Usage: alphred run --tree <tree_key> [--repo <name|github:owner/repo|azure:org/project/repo>] [--branch <branch_name>]';
const STATUS_USAGE = 'Usage: alphred status --run <run_id>';
const LIST_USAGE = 'Usage: alphred list';
const REPO_USAGE = 'Usage: alphred repo <add|list|show|remove|sync>';
const REPO_ADD_USAGE = 'Usage: alphred repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)';
const REPO_LIST_USAGE = 'Usage: alphred repo list';
const REPO_SHOW_USAGE = 'Usage: alphred repo show <name>';
const REPO_REMOVE_USAGE = 'Usage: alphred repo remove <name> [--purge]';
const REPO_SYNC_USAGE = 'Usage: alphred repo sync <name>';
type ScmAuthPreflightMode = 'warn' | 'require';

function isRunControlAction(value: string): value is WorkflowRunControlAction {
  return value === 'cancel' || value === 'pause' || value === 'resume' || value === 'retry';
}

function getRunControlUsage(action: WorkflowRunControlAction): string {
  return `Usage: alphred run ${action} --run <run_id>`;
}

function parseGitHubRemoteRef(ref: string): { remoteRef: string; remoteUrl: string; derivedName: string } {
  const segments = ref
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length !== 2) {
    throw new Error(`Invalid GitHub repository reference "${ref}". Expected owner/repo.`);
  }

  const [owner, repository] = segments;
  return {
    remoteRef: `${owner}/${repository}`,
    remoteUrl: `https://github.com/${owner}/${repository}.git`,
    derivedName: repository,
  };
}

function parseAzureRemoteRef(ref: string): { remoteRef: string; remoteUrl: string; derivedName: string } {
  const segments = ref
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length !== 3) {
    throw new Error(`Invalid Azure repository reference "${ref}". Expected org/project/repository.`);
  }

  const [organization, project, repository] = segments;
  return {
    remoteRef: `${organization}/${project}/${repository}`,
    remoteUrl: `https://dev.azure.com/${organization}/${project}/_git/${repository}`,
    derivedName: repository,
  };
}

function parseRunRepositoryInput(value: string): (
  | {
      kind: 'name';
      repoName: string;
    }
  | {
      kind: 'shorthand';
      repoName: string;
      provider: RepositoryConfig['provider'];
      remoteRef: string;
      remoteUrl: string;
    }
) {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error('Repository selector cannot be empty.');
  }

  if (trimmedValue.startsWith('github:')) {
    const parsed = parseGitHubRemoteRef(trimmedValue.slice('github:'.length));
    return {
      kind: 'shorthand',
      repoName: parsed.derivedName,
      provider: 'github',
      remoteRef: parsed.remoteRef,
      remoteUrl: parsed.remoteUrl,
    };
  }

  if (trimmedValue.startsWith('azure:')) {
    const parsed = parseAzureRemoteRef(trimmedValue.slice('azure:'.length));
    return {
      kind: 'shorthand',
      repoName: parsed.derivedName,
      provider: 'azure-devops',
      remoteRef: parsed.remoteRef,
      remoteUrl: parsed.remoteUrl,
    };
  }

  return {
    kind: 'name',
    repoName: trimmedValue,
  };
}

function assertRepositoryIdentity(existing: RepositoryConfig, expected: Pick<InsertRepositoryParams, 'provider' | 'remoteRef' | 'remoteUrl'>): void {
  if (existing.provider !== expected.provider) {
    throw new Error(
      `Repository "${existing.name}" provider mismatch. Existing=${existing.provider}, expected=${expected.provider}.`,
    );
  }

  if (existing.remoteRef !== expected.remoteRef) {
    throw new Error(
      `Repository "${existing.name}" remoteRef mismatch. Existing=${existing.remoteRef}, expected=${expected.remoteRef}.`,
    );
  }

  if (existing.remoteUrl !== expected.remoteUrl) {
    throw new Error(
      `Repository "${existing.name}" remoteUrl mismatch. Existing=${existing.remoteUrl}, expected=${expected.remoteUrl}.`,
    );
  }
}

function resolveRunRepository(db: AlphredDatabase, value: string): ResolvedRunRepository {
  const parsedInput = parseRunRepositoryInput(value);
  if (parsedInput.kind === 'name') {
    const existing = getRepositoryByName(db, parsedInput.repoName);
    if (!existing) {
      throw new Error(`Repository "${parsedInput.repoName}" was not found.`);
    }
    return {
      repoName: existing.name,
      autoRegistered: false,
    };
  }

  const existing = getRepositoryByName(db, parsedInput.repoName);
  if (existing) {
    assertRepositoryIdentity(existing, {
      provider: parsedInput.provider,
      remoteRef: parsedInput.remoteRef,
      remoteUrl: parsedInput.remoteUrl,
    });
    return {
      repoName: existing.name,
      autoRegistered: false,
    };
  }

  insertRepository(db, {
    name: parsedInput.repoName,
    provider: parsedInput.provider,
    remoteRef: parsedInput.remoteRef,
    remoteUrl: parsedInput.remoteUrl,
  });
  return {
    repoName: parsedInput.repoName,
    autoRegistered: true,
    provider: parsedInput.provider,
    remoteRef: parsedInput.remoteRef,
  };
}

function renderRepositoryTableRows(repositoryRows: readonly RepositoryConfig[]): string[] {
  const headers = ['NAME', 'PROVIDER', 'REMOTE_REF', 'CLONE_STATUS', 'LOCAL_PATH'] as const;
  const rows = repositoryRows.map(repository => [
    repository.name,
    repository.provider,
    repository.remoteRef,
    repository.cloneStatus,
    repository.localPath ?? '-',
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)),
  );
  const toLine = (values: readonly string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join('  ');

  const divider = widths.map(width => '-'.repeat(width)).join('  ');
  return [
    toLine(headers),
    divider,
    ...rows.map(toLine),
  ];
}

function parseRepoAddConfig(options: ReadonlyMap<string, string>): {
  provider: RepositoryConfig['provider'];
  remoteRef: string;
  remoteUrl: string;
} {
  const githubRef = options.get('github');
  const azureRef = options.get('azure');
  if (githubRef && azureRef) {
    throw new Error('Options "--github" and "--azure" cannot be used together.');
  }
  if (!githubRef && !azureRef) {
    throw new Error('One of "--github" or "--azure" is required.');
  }

  if (githubRef) {
    const parsed = parseGitHubRemoteRef(githubRef);
    return {
      provider: 'github',
      remoteRef: parsed.remoteRef,
      remoteUrl: parsed.remoteUrl,
    };
  }

  const parsed = parseAzureRemoteRef(azureRef ?? '');
  return {
    provider: 'azure-devops',
    remoteRef: parsed.remoteRef,
    remoteUrl: parsed.remoteUrl,
  };
}

function parseRunCommandInput(rawArgs: readonly string[], io: CliIo): ParsedRunCommandInput {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'run',
      usage: RUN_USAGE,
      allowedOptions: ['tree', 'repo', 'branch'],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return {
      ok: false,
      exitCode: parsedOptions.exitCode,
    };
  }

  const treeKey = getRequiredOption(parsedOptions.options, 'tree', 'tree_key', RUN_USAGE, io);
  if (!treeKey) {
    return {
      ok: false,
      exitCode: EXIT_USAGE_ERROR,
    };
  }

  const repoOption = parsedOptions.options.get('repo');
  const repoInput = repoOption?.trim();
  if (repoOption !== undefined && repoInput === '') {
    return {
      ok: false,
      exitCode: usageError(io, 'Option "--repo" requires a value.', RUN_USAGE),
    };
  }

  const branchOption = parsedOptions.options.get('branch');
  const branchOverride = branchOption?.trim();
  if (branchOption !== undefined && branchOverride === '') {
    return {
      ok: false,
      exitCode: usageError(io, 'Option "--branch" requires a value.', RUN_USAGE),
    };
  }

  if (branchOverride && !repoInput) {
    return {
      ok: false,
      exitCode: usageError(io, 'Option "--branch" requires "--repo".', RUN_USAGE),
    };
  }

  return {
    ok: true,
    treeKey,
    repoInput: repoInput ?? null,
    branchOverride,
  };
}

async function handleRunControlCommand(
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

function formatScmProviderLabel(provider: RepositoryConfig['provider']): string {
  return provider === 'github' ? 'GitHub' : 'Azure DevOps';
}

function toScmProviderConfigForAuth(
  repository: Pick<RepositoryConfig, 'provider' | 'remoteRef'>,
): ScmProviderConfig {
  if (repository.provider === 'github') {
    return {
      kind: 'github',
      repo: repository.remoteRef,
    };
  }

  const segments = repository.remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length !== 3) {
    throw new Error(
      `Invalid Azure repository reference "${repository.remoteRef}". Expected org/project/repository.`,
    );
  }

  return {
    kind: 'azure-devops',
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}

async function runScmAuthPreflight(
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

function reportAutoRegisteredRepository(io: Pick<CliIo, 'stdout'>, repository: ResolvedRunRepository | null): void {
  if (!repository?.autoRegistered) {
    return;
  }

  io.stdout(`Auto-registered repository "${repository.repoName}" from ${repository.provider}:${repository.remoteRef}.`);
}

function materializeRun(treeKey: string, db: AlphredDatabase, io: Pick<CliIo, 'stdout'>): number {
  const planner = createSqlWorkflowPlanner(db);
  const materializedRun = planner.materializeRun({ treeKey });
  const runId = materializedRun.run.id;
  io.stdout(`Started run id=${runId} for tree "${treeKey}".`);
  return runId;
}

async function setupRunExecution(
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

function summarizeRunExecution(execution: RunExecutionSummary, io: CliIo): ExitCode {
  io.stdout(
    `Run id=${execution.workflowRunId} outcome=${execution.finalStep.outcome} status=${execution.finalStep.runStatus} executed_nodes=${execution.executedNodes}.`,
  );

  if (shouldTreatRunStatusAsFailure(execution.finalStep.runStatus)) {
    io.stderr(`Run id=${execution.workflowRunId} finished with status=${execution.finalStep.runStatus}.`);
    return EXIT_RUNTIME_ERROR;
  }

  return EXIT_SUCCESS;
}

function cancelPendingRunAfterSetupFailure(db: AlphredDatabase, runId: number, io: Pick<CliIo, 'stderr'>): void {
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

function mapRunExecutionError(error: unknown, treeKey: string, io: Pick<CliIo, 'stderr'>): ExitCode {
  if (hasErrorCode(error, 'WORKFLOW_TREE_NOT_FOUND')) {
    io.stderr(`Workflow tree not found for key "${treeKey}".`);
    return EXIT_NOT_FOUND;
  }

  io.stderr(`Failed to execute run: ${toErrorMessage(error)}`);
  return EXIT_RUNTIME_ERROR;
}

async function cleanupRunWorktrees(
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

async function prepareRunRepository(
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

async function handleRunCommand(rawArgs: readonly string[], dependencies: CliDependencies, io: CliIo): Promise<ExitCode> {
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

async function handleRepoAddCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo add',
      usage: REPO_ADD_USAGE,
      allowedOptions: ['name', 'github', 'azure'],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const rawName = getRequiredOption(parsedOptions.options, 'name', 'name', REPO_ADD_USAGE, io);
  if (!rawName) {
    return EXIT_USAGE_ERROR;
  }

  const name = rawName.trim();
  if (name.length === 0) {
    usageError(io, 'Repository name cannot be empty.', REPO_ADD_USAGE);
    return EXIT_USAGE_ERROR;
  }

  let repoConfig: ReturnType<typeof parseRepoAddConfig>;
  try {
    repoConfig = parseRepoAddConfig(parsedOptions.options);
  } catch (error) {
    return usageError(io, toErrorMessage(error), REPO_ADD_USAGE);
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const existing = getRepositoryByName(db, name);
    if (existing) {
      io.stderr(`Repository "${name}" already exists.`);
      return EXIT_RUNTIME_ERROR;
    }
    const authExitCode = await runScmAuthPreflight(repoConfig, dependencies, io, {
      commandName: 'repo add',
      mode: 'warn',
    });
    if (authExitCode !== null) {
      return authExitCode;
    }

    const inserted = insertRepository(db, {
      name,
      provider: repoConfig.provider,
      remoteRef: repoConfig.remoteRef,
      remoteUrl: repoConfig.remoteUrl,
    });
    io.stdout(`Registered repository "${inserted.name}" (${inserted.provider}:${inserted.remoteRef}).`);
    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to add repository: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleRepoListCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo list',
      usage: REPO_LIST_USAGE,
      allowedOptions: [],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const repositoryRows = listRepositories(db);
    if (repositoryRows.length === 0) {
      io.stdout('No repositories registered.');
      return EXIT_SUCCESS;
    }

    for (const line of renderRepositoryTableRows(repositoryRows)) {
      io.stdout(line);
    }
    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to list repositories: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleRepoShowCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo show',
      usage: REPO_SHOW_USAGE,
      allowedOptions: [],
      positionalCount: 1,
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const name = parsedOptions.positionals[0]?.trim() ?? '';
  if (name.length === 0) {
    return usageError(io, 'Repository name cannot be empty.', REPO_SHOW_USAGE);
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const repository = getRepositoryByName(db, name);
    if (!repository) {
      io.stderr(`Repository "${name}" was not found.`);
      return EXIT_NOT_FOUND;
    }

    io.stdout(`Name: ${repository.name}`);
    io.stdout(`Provider: ${repository.provider}`);
    io.stdout(`Remote ref: ${repository.remoteRef}`);
    io.stdout(`Remote URL: ${repository.remoteUrl}`);
    io.stdout(`Default branch: ${repository.defaultBranch}`);
    io.stdout(`Branch template: ${repository.branchTemplate ?? '(none)'}`);
    io.stdout(`Clone status: ${repository.cloneStatus}`);
    io.stdout(`Local path: ${repository.localPath ?? '(none)'}`);
    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to show repository: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleRepoRemoveCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo remove',
      usage: REPO_REMOVE_USAGE,
      allowedOptions: ['purge'],
      flagOptions: ['purge'],
      positionalCount: 1,
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const name = parsedOptions.positionals[0]?.trim() ?? '';
  if (name.length === 0) {
    return usageError(io, 'Repository name cannot be empty.', REPO_REMOVE_USAGE);
  }

  const purge = parsedOptions.options.get('purge') === 'true';
  try {
    const db = openInitializedDatabase(dependencies, io);
    const repository = getRepositoryByName(db, name);
    if (!repository) {
      io.stderr(`Repository "${name}" was not found.`);
      return EXIT_NOT_FOUND;
    }

    const referencedRunWorktree = db
      .select({
        id: runWorktrees.id,
      })
      .from(runWorktrees)
      .where(eq(runWorktrees.repositoryId, repository.id))
      .limit(1)
      .get();
    if (referencedRunWorktree) {
      io.stderr(`Repository "${name}" cannot be removed because run-worktree history references it.`);
      return EXIT_RUNTIME_ERROR;
    }

    if (purge && repository.localPath) {
      await dependencies.removeDirectory(repository.localPath);
    }

    const deleted = db
      .delete(repositories)
      .where(eq(repositories.id, repository.id))
      .run();
    if (deleted.changes !== 1) {
      io.stderr(`Repository "${name}" could not be removed.`);
      return EXIT_RUNTIME_ERROR;
    }

    if (purge && repository.localPath) {
      io.stdout(`Removed repository "${name}" and purged "${repository.localPath}".`);
    } else {
      io.stdout(`Removed repository "${name}".`);
    }

    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to remove repository: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleRepoSyncCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo sync',
      usage: REPO_SYNC_USAGE,
      allowedOptions: [],
      positionalCount: 1,
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  const name = parsedOptions.positionals[0]?.trim() ?? '';
  if (name.length === 0) {
    return usageError(io, 'Repository name cannot be empty.', REPO_SYNC_USAGE);
  }

  try {
    const db = openInitializedDatabase(dependencies, io);
    const repository = getRepositoryByName(db, name);
    if (!repository) {
      io.stderr(`Repository "${name}" was not found.`);
      return EXIT_NOT_FOUND;
    }
    const authExitCode = await runScmAuthPreflight(repository, dependencies, io, {
      commandName: 'repo sync',
      mode: 'require',
    });
    if (authExitCode !== null) {
      return authExitCode;
    }

    const synced = await dependencies.ensureRepositoryClone({
      db,
      repository: {
        name: repository.name,
        provider: repository.provider,
        remoteUrl: repository.remoteUrl,
        remoteRef: repository.remoteRef,
        defaultBranch: repository.defaultBranch,
      },
      environment: io.env,
    });
    io.stdout(
      `Repository "${name}" ${synced.action} at "${synced.repository.localPath ?? '(unknown path)'}".`,
    );
    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to sync repository: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

async function handleRepoCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const subcommand = rawArgs[0];
  if (!subcommand) {
    return usageError(io, 'Missing required repo subcommand.', REPO_USAGE);
  }

  switch (subcommand) {
    case 'add':
      return handleRepoAddCommand(rawArgs.slice(1), dependencies, io);
    case 'list':
      return handleRepoListCommand(rawArgs.slice(1), dependencies, io);
    case 'show':
      return handleRepoShowCommand(rawArgs.slice(1), dependencies, io);
    case 'remove':
      return handleRepoRemoveCommand(rawArgs.slice(1), dependencies, io);
    case 'sync':
      return handleRepoSyncCommand(rawArgs.slice(1), dependencies, io);
    default:
      return usageError(io, `Unknown repo subcommand "${subcommand}".`, REPO_USAGE);
  }
}

async function handleStatusCommand(
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

async function handleListCommand(rawArgs: readonly string[], io: Pick<CliIo, 'stderr'>): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'list',
      usage: LIST_USAGE,
      allowedOptions: [],
    },
    io,
  );
  if (!parsedOptions.ok) {
    return parsedOptions.exitCode;
  }

  io.stderr('The "list" command is not implemented yet.');
  return EXIT_RUNTIME_ERROR;
}

function normalizePathForComparison(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function isExecutedAsScript(
  entrypoint: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entrypoint) {
    return false;
  }

  const entrypointPath = normalizePathForComparison(entrypoint);
  const modulePath = normalizePathForComparison(fileURLToPath(moduleUrl));
  return modulePath === entrypointPath;
}

function createDefaultEntrypointRuntime(): CliEntrypointRuntime {
  return {
    argv: process.argv,
    exit: code => process.exit(code),
  };
}

export async function runCliEntrypoint(
  runtime: CliEntrypointRuntime = createDefaultEntrypointRuntime(),
  options: MainOptions = {},
): Promise<void> {
  const exitCode = await main(runtime.argv.slice(2), options);
  if (exitCode !== EXIT_SUCCESS) {
    runtime.exit(exitCode);
  }
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
    case 'repo':
      return handleRepoCommand(args.slice(1), dependencies, io);
    case 'list':
      return handleListCommand(args.slice(1), io);
    default:
      io.stderr(`Unknown command "${command}".`);
      printGeneralUsage({ stdout: io.stderr });
      return EXIT_USAGE_ERROR;
  }
}

if (isExecutedAsScript()) {
  try {
    await runCliEntrypoint();
  } catch (error: unknown) {
    console.error(`Fatal error: ${toErrorMessage(error)}`);
    process.exit(EXIT_RUNTIME_ERROR);
  }
}
