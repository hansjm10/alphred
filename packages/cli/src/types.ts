import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAgentProvider } from '@alphred/agents';
import {
  createDatabase,
  migrateDatabase,
  type AlphredDatabase,
  type RunNodeStatus,
  type WorkflowRunStatus,
} from '@alphred/db';
import type { PhaseProviderResolver } from '@alphred/core';
import {
  WorktreeManager,
  createScmProvider as createGitScmProvider,
  ensureRepositoryClone,
  resolveSandboxDir,
  type ScmProviderConfig,
} from '@alphred/git';
import type { AuthStatus, RepositoryConfig } from '@alphred/shared';
import {
  EXIT_NOT_FOUND,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from './constants.js';

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_USAGE_ERROR
  | typeof EXIT_NOT_FOUND
  | typeof EXIT_RUNTIME_ERROR;

export type CliIo = {
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

export type MainOptions = {
  dependencies?: CliDependencies;
  io?: CliIo;
};

export type CliEntrypointRuntime = {
  argv: string[];
  exit: (code: number) => void;
};

export type ParsedOptions =
  | {
      ok: true;
      options: Map<string, string>;
      positionals: string[];
    }
  | {
      ok: false;
      message: string;
    };

export type ParsedLongOptionToken =
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

export type ValidatedCommandOptions =
  | {
      ok: true;
      options: Map<string, string>;
      positionals: string[];
    }
  | {
      ok: false;
      exitCode: ExitCode;
    };

export type CommandValidationConfig = {
  commandName: string;
  usage: string;
  allowedOptions: readonly string[];
  flagOptions?: readonly string[];
  positionalCount?: number;
};

export type ResolvedRunRepository =
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

export type RunWorktreeManager = ReturnType<CliDependencies['createWorktreeManager']>;

export type ParsedRunCommandInput =
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

export type RunExecutionSetup = {
  workingDirectory: string;
  worktreeManager: RunWorktreeManager | null;
};

export type RunRepositoryPreparation = {
  resolvedRepo: ResolvedRunRepository | null;
  worktreeManager: RunWorktreeManager | null;
  authExitCode: ExitCode | null;
};

export type RunExecutionSummary = {
  workflowRunId: number;
  finalStep: {
    outcome: string;
    runStatus: WorkflowRunStatus;
  };
  executedNodes: number;
};

export type DisplayRunNode = {
  id: number;
  nodeKey: string;
  status: RunNodeStatus;
  attempt: number;
  sequenceIndex: number;
};

export type ScmAuthPreflightMode = 'warn' | 'require';

export const orderedNodeStatuses: readonly RunNodeStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

export const defaultDependencies: CliDependencies = {
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
