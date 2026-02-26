import { eq } from 'drizzle-orm';
import {
  getRepositoryByName,
  insertRepository,
  listRepositories,
  repositories,
  runWorktrees,
} from '@alphred/db';
import {
  EXIT_NOT_FOUND,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  REPO_ADD_USAGE,
  REPO_LIST_USAGE,
  REPO_REMOVE_USAGE,
  REPO_SHOW_USAGE,
  REPO_SYNC_USAGE,
  REPO_USAGE,
} from '../constants.js';
import { openInitializedDatabase, runScmAuthPreflight } from '../execution.js';
import { toErrorMessage, usageError } from '../io.js';
import {
  formatRepoSyncSummary,
  getRequiredOption,
  parseRepoAddConfig,
  parseRepoSyncStrategy,
  validateCommandOptions,
} from '../parsing.js';
import { renderRepositoryTableRows } from '../repository.js';
import type { CliDependencies, CliIo, ExitCode } from '../types.js';

export async function handleRepoAddCommand(
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

export async function handleRepoListCommand(
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

export async function handleRepoShowCommand(
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

export async function handleRepoRemoveCommand(
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

export async function handleRepoSyncCommand(
  rawArgs: readonly string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<ExitCode> {
  const parsedOptions = validateCommandOptions(
    rawArgs,
    {
      commandName: 'repo sync',
      usage: REPO_SYNC_USAGE,
      allowedOptions: ['strategy'],
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
  const syncStrategy = parseRepoSyncStrategy(parsedOptions.options.get('strategy'), io);
  if (!syncStrategy) {
    return EXIT_USAGE_ERROR;
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
      sync: {
        mode: 'pull',
        strategy: syncStrategy,
      },
    });
    const localPath = synced.repository.localPath ?? '(unknown path)';
    if (synced.sync?.status === 'conflicted') {
      io.stderr(synced.sync.conflictMessage ?? `Repository "${name}" sync encountered conflicts.`);
      io.stderr(`Repository "${name}" remains at "${localPath}".`);
      return EXIT_RUNTIME_ERROR;
    }

    io.stdout(`Repository "${name}" ${synced.action} at "${localPath}".`);
    io.stdout(formatRepoSyncSummary(synced.sync));
    return EXIT_SUCCESS;
  } catch (error) {
    io.stderr(`Failed to sync repository: ${toErrorMessage(error)}`);
    return EXIT_RUNTIME_ERROR;
  }
}

export async function handleRepoCommand(
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
