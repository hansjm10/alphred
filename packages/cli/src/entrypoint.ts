import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from './constants.js';
import { handleListCommand } from './commands/list.js';
import { handleRepoCommand } from './commands/repo.js';
import { handleRunCommand } from './commands/run.js';
import { handleStatusCommand } from './commands/status.js';
import { createDefaultIo, printGeneralUsage } from './io.js';
import type {
  CliEntrypointRuntime,
  ExitCode,
  MainOptions,
} from './types.js';
import { defaultDependencies } from './types.js';

export function normalizePathForComparison(path: string): string {
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

export function createDefaultEntrypointRuntime(): CliEntrypointRuntime {
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
