#!/usr/bin/env node

import { EXIT_RUNTIME_ERROR } from './constants.js';
import { isExecutedAsScript, runCliEntrypoint } from './entrypoint.js';
import { toErrorMessage } from './io.js';

export { createDefaultEntrypointRuntime, isExecutedAsScript, main, normalizePathForComparison, runCliEntrypoint } from './entrypoint.js';
export type { CliDependencies, CliEntrypointRuntime, MainOptions } from './types.js';

if (isExecutedAsScript()) {
  try {
    await runCliEntrypoint();
  } catch (error: unknown) {
    console.error(`Fatal error: ${toErrorMessage(error)}`);
    process.exit(EXIT_RUNTIME_ERROR);
  }
}
