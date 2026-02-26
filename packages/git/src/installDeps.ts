import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export const INSTALL_COMMAND_ENV_KEY = 'ALPHRED_INSTALL_CMD';
export const INSTALL_SKIP_ENV_KEY = 'ALPHRED_SKIP_INSTALL';
export const INSTALL_TIMEOUT_ENV_KEY = 'ALPHRED_INSTALL_TIMEOUT_MS';
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

type InstallLockfileCommand = {
  lockfiles: readonly string[];
  command: string;
  args: readonly string[];
};

type InstallLockfileCommandDefinition = readonly [
  lockfiles: readonly string[],
  command: string,
  args?: readonly string[],
];

const defaultInstallCommandArgs = ['install'] as const;

const lockfileInstallCommands = createLockfileInstallCommands([
  [['pnpm-lock.yaml'], 'pnpm'],
  [['bun.lockb', 'bun.lock'], 'bun'],
  [['yarn.lock'], 'yarn'],
  [['package-lock.json'], 'npm'],
  [['uv.lock'], 'uv', ['sync']],
  [['poetry.lock'], 'poetry'],
  [['Pipfile.lock'], 'pipenv'],
  [['requirements.txt'], 'pip', ['install', '-r', 'requirements.txt']],
  [['Gemfile.lock'], 'bundle'],
  [['go.sum'], 'go', ['mod', 'download']],
  [['Cargo.lock'], 'cargo', ['fetch']],
]);

export type InstallOutput = {
  stream: 'stdout' | 'stderr';
  chunk: string;
};

export type InstallDepsResult =
  | {
      status: 'skipped';
      reason: SkipInstallReason;
    }
  | {
      status: 'installed';
      source: 'override' | 'lockfile';
      command: string;
      lockfile?: string;
      timeoutMs: number;
    };

type ResolvedInstallCommand = {
  source: 'override' | 'lockfile';
  command: string;
  args: readonly string[];
  displayCommand: string;
  shell: boolean;
  lockfile?: string;
};

type ResolveInstallCommandResult =
  | {
      kind: 'skip';
      reason: SkipInstallReason;
    }
  | {
      kind: 'run';
      command: ResolvedInstallCommand;
      timeoutMs: number;
    };

type SpawnedInstallProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: 'error' | 'close', listener: (...args: unknown[]) => void) => void;
};

type SpawnInstallCommandParams = {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  shell: boolean;
};

export type SpawnInstallCommand = (params: SpawnInstallCommandParams) => SpawnedInstallProcess;

type RunInstallCommandOptions = {
  command: ResolvedInstallCommand;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (output: InstallOutput) => void;
  spawnCommand?: SpawnInstallCommand;
};

export type InstallDepsOptions = {
  worktreePath: string;
  environment?: NodeJS.ProcessEnv;
  skipInstall?: boolean;
  timeoutMs?: number;
  onOutput?: (output: InstallOutput) => void;
  fileExists?: (path: string) => Promise<boolean>;
  runCommand?: (options: RunInstallCommandOptions) => Promise<void>;
};

type SkipInstallReason = 'skip_option' | 'skip_env' | 'no_lockfile';

export async function installDependencies(options: InstallDepsOptions): Promise<InstallDepsResult> {
  const environment = options.environment ?? process.env;
  const resolved = await resolveInstallCommand({
    worktreePath: options.worktreePath,
    environment,
    skipInstall: options.skipInstall,
    timeoutMs: options.timeoutMs,
    fileExists: options.fileExists ?? defaultFileExists,
  });

  if (resolved.kind === 'skip') {
    return {
      status: 'skipped',
      reason: resolved.reason,
    };
  }

  const onOutput = options.onOutput ?? defaultInstallOutputWriter;
  const runCommand = options.runCommand ?? runInstallCommand;
  await runCommand({
    command: resolved.command,
    cwd: options.worktreePath,
    environment,
    timeoutMs: resolved.timeoutMs,
    onOutput,
  });

  return {
    status: 'installed',
    source: resolved.command.source,
    command: resolved.command.displayCommand,
    lockfile: resolved.command.lockfile,
    timeoutMs: resolved.timeoutMs,
  };
}

export async function runInstallCommand(options: RunInstallCommandOptions): Promise<void> {
  const childProcess = (options.spawnCommand ?? defaultSpawnInstallCommand)({
    command: options.command.command,
    args: options.command.args,
    cwd: options.cwd,
    environment: options.environment,
    shell: options.command.shell,
  });

  attachOutputStream({
    stream: childProcess.stdout,
    streamName: 'stdout',
    onOutput: options.onOutput,
  });
  attachOutputStream({
    stream: childProcess.stderr,
    streamName: 'stderr',
    onOutput: options.onOutput,
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      childProcess.kill('SIGTERM');
      hardKillTimer = setTimeout(() => {
        childProcess.kill('SIGKILL');
      }, 2_000);
    }, options.timeoutMs);

    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    childProcess.once('error', error => {
      const reason = error instanceof Error ? error.message : String(error);
      settle(
        new Error(
          `Install command "${options.command.displayCommand}" failed to start: ${reason}`,
        ),
      );
    });

    childProcess.once('close', (code, signal) => {
      if (timedOut) {
        settle(
          new Error(
            `Install command "${options.command.displayCommand}" timed out after ${options.timeoutMs}ms.`,
          ),
        );
        return;
      }

      if (code === 0) {
        settle();
        return;
      }

      const signalSuffix = typeof signal === 'string' ? ` (signal: ${signal})` : '';
      let exitCodeLabel = 'unknown';
      if (typeof code === 'number') {
        exitCodeLabel = code.toString(10);
      } else if (code === null) {
        exitCodeLabel = 'null';
      }
      settle(
        new Error(
          `Install command "${options.command.displayCommand}" failed with exit code ${exitCodeLabel}${signalSuffix}.`,
        ),
      );
    });
  });
}

async function resolveInstallCommand(params: {
  worktreePath: string;
  environment: NodeJS.ProcessEnv;
  skipInstall?: boolean;
  timeoutMs?: number;
  fileExists: (path: string) => Promise<boolean>;
}): Promise<ResolveInstallCommandResult> {
  if (params.skipInstall === true) {
    return createSkipResolution('skip_option');
  }

  if (shouldSkipInstallFromEnvironment(params.environment)) {
    return createSkipResolution('skip_env');
  }

  const override = params.environment[INSTALL_COMMAND_ENV_KEY]?.trim();
  const timeoutMs = resolveInstallTimeoutMs(params.timeoutMs, params.environment);
  if (override !== undefined && override.length > 0) {
    return createRunResolution(
      {
        source: 'override',
        command: override,
        args: [],
        displayCommand: override,
        shell: true,
      },
      timeoutMs,
    );
  }

  for (const installCommand of lockfileInstallCommands) {
    for (const lockfile of installCommand.lockfiles) {
      if (await params.fileExists(join(params.worktreePath, lockfile))) {
        return createRunResolution(
          {
            source: 'lockfile',
            command: installCommand.command,
            args: installCommand.args,
            displayCommand: formatInstallCommand(installCommand.command, installCommand.args),
            shell: false,
            lockfile,
          },
          timeoutMs,
        );
      }
    }
  }

  return createSkipResolution('no_lockfile');
}

function createSkipResolution(reason: SkipInstallReason): ResolveInstallCommandResult {
  return {
    kind: 'skip',
    reason,
  };
}

function createRunResolution(
  command: ResolvedInstallCommand,
  timeoutMs: number,
): ResolveInstallCommandResult {
  return {
    kind: 'run',
    command,
    timeoutMs,
  };
}

function shouldSkipInstallFromEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return environment[INSTALL_SKIP_ENV_KEY]?.trim() === '1';
}

function resolveInstallTimeoutMs(explicitTimeoutMs: number | undefined, environment: NodeJS.ProcessEnv): number {
  if (explicitTimeoutMs !== undefined) {
    return parsePositiveInteger(explicitTimeoutMs, 'timeoutMs');
  }

  const fromEnvironment = environment[INSTALL_TIMEOUT_ENV_KEY]?.trim();
  if (fromEnvironment === undefined || fromEnvironment.length === 0) {
    return DEFAULT_INSTALL_TIMEOUT_MS;
  }

  return parsePositiveInteger(fromEnvironment, INSTALL_TIMEOUT_ENV_KEY);
}

function parsePositiveInteger(value: number | string, label: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return numeric;
}

function createLockfileInstallCommands(
  definitions: readonly InstallLockfileCommandDefinition[],
): readonly InstallLockfileCommand[] {
  return definitions.map(([lockfiles, command, args]) => ({
    lockfiles,
    command,
    args: args ?? defaultInstallCommandArgs,
  }));
}

function formatInstallCommand(command: string, args: readonly string[]): string {
  return args.length === 0 ? command : `${command} ${args.join(' ')}`;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function attachOutputStream(params: {
  stream: NodeJS.ReadableStream | null;
  streamName: InstallOutput['stream'];
  onOutput: (output: InstallOutput) => void;
}): void {
  if (!params.stream) {
    return;
  }

  params.stream.setEncoding('utf8');
  params.stream.on('data', chunk => {
    params.onOutput({
      stream: params.streamName,
      chunk: toOutputChunk(chunk),
    });
  });
}

function toOutputChunk(chunk: unknown): string {
  return typeof chunk === 'string' ? chunk : String(chunk);
}

function defaultSpawnInstallCommand(params: SpawnInstallCommandParams): SpawnedInstallProcess {
  return spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.environment,
    shell: params.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function defaultInstallOutputWriter(output: InstallOutput): void {
  if (output.stream === 'stdout') {
    process.stdout.write(output.chunk);
    return;
  }

  process.stderr.write(output.chunk);
}
