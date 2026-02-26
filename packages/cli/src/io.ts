import { EXIT_USAGE_ERROR } from './constants.js';
import type { CliIo, ExitCode } from './types.js';

export function createDefaultIo(): CliIo {
  return {
    stdout: message => console.log(message),
    stderr: message => console.error(message),
    cwd: process.cwd(),
    env: process.env,
  };
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === expectedCode
  );
}

export function isWorkflowRunNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Workflow run id=\d+ was not found\.$/.test(error.message);
}

export function printGeneralUsage(io: Pick<CliIo, 'stdout'>): void {
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
  io.stdout('  repo sync <name> [--strategy <ff-only|merge|rebase>]');
  io.stdout('                             Clone or fetch repository into sandbox and update branch state');
  io.stdout('  list                     List available workflows (not implemented)');
}

export function usageError(io: Pick<CliIo, 'stderr'>, message: string, usage: string): ExitCode {
  io.stderr(message);
  io.stderr(usage);
  return EXIT_USAGE_ERROR;
}
