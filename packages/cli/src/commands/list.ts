import {
  EXIT_RUNTIME_ERROR,
  LIST_USAGE,
} from '../constants.js';
import { validateCommandOptions } from '../parsing.js';
import type { CliIo, ExitCode } from '../types.js';

export async function handleListCommand(rawArgs: readonly string[], io: Pick<CliIo, 'stderr'>): Promise<ExitCode> {
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
