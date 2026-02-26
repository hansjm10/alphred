import type { WorkflowRunControlAction } from '@alphred/core';
import {
  repositorySyncStrategies,
  type RepositorySyncDetails,
  type RepositorySyncStrategy,
} from '@alphred/git';
import type { RepositoryConfig } from '@alphred/shared';
import {
  EXIT_USAGE_ERROR,
  REPO_SYNC_USAGE,
  RUN_USAGE,
} from './constants.js';
import { usageError } from './io.js';
import type {
  CliIo,
  CommandValidationConfig,
  ParsedLongOptionToken,
  ParsedOptions,
  ParsedRunCommandInput,
  ValidatedCommandOptions,
} from './types.js';

export function parseLongOptionToken(arg: string, flagOptions: ReadonlySet<string>): ParsedLongOptionToken {
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

export function parseLongOptions(
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

export function validateCommandOptions(
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

export function getRequiredOption(
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

export function parseStrictPositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}

const repoSyncStrategySet = new Set<RepositorySyncStrategy>(repositorySyncStrategies);

export function parseRepoSyncStrategy(value: string | undefined, io: Pick<CliIo, 'stderr'>): RepositorySyncStrategy | null {
  if (value === undefined) {
    return 'ff-only';
  }

  if (repoSyncStrategySet.has(value as RepositorySyncStrategy)) {
    return value as RepositorySyncStrategy;
  }

  io.stderr(`Option "--strategy" must be one of: ${repositorySyncStrategies.join(', ')}.`);
  io.stderr(REPO_SYNC_USAGE);
  return null;
}

export function formatRepoSyncSummary(sync: RepositorySyncDetails | undefined): string {
  if (!sync) {
    return 'Sync status unavailable.';
  }

  const modeLabel = sync.mode === 'pull' ? 'pull' : 'fetch';
  const strategyLabel = sync.strategy === null ? 'n/a' : sync.strategy;
  const branchLabel = sync.branch === null ? 'n/a' : sync.branch;
  return `Sync status: ${sync.status} (mode=${modeLabel}, strategy=${strategyLabel}, branch=${branchLabel}).`;
}

export function isRunControlAction(value: string): value is WorkflowRunControlAction {
  return value === 'cancel' || value === 'pause' || value === 'resume' || value === 'retry';
}

export function getRunControlUsage(action: WorkflowRunControlAction): string {
  return `Usage: alphred run ${action} --run <run_id>`;
}

export function parseGitHubRemoteRef(ref: string): { remoteRef: string; remoteUrl: string; derivedName: string } {
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

export function parseAzureRemoteRef(ref: string): { remoteRef: string; remoteUrl: string; derivedName: string } {
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

export function parseRunRepositoryInput(value: string):
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
    } {
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

export function parseRepoAddConfig(options: ReadonlyMap<string, string>): {
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

export function parseRunCommandInput(rawArgs: readonly string[], io: CliIo): ParsedRunCommandInput {
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
