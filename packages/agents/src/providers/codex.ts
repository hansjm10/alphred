import type { ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from '../provider.js';
import {
  type AdapterProviderConfig,
  type AdapterRawEvent,
  type AdapterRunRequest,
  type AdapterRunner,
  createDefaultAdapterRunner,
  runAdapterProvider,
} from './adapterProviderCore.js';

export type CodexProviderErrorCode =
  | 'CODEX_INVALID_OPTIONS'
  | 'CODEX_INVALID_EVENT'
  | 'CODEX_MISSING_RESULT'
  | 'CODEX_RUN_FAILED';

export class CodexProviderError extends Error {
  readonly code: CodexProviderErrorCode;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: CodexProviderErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'CodexProviderError';
    this.code = code;
    this.details = details;
    this.cause = cause;
  }
}

export type CodexRunRequest = AdapterRunRequest;
export type CodexRawEvent = AdapterRawEvent;
export type CodexRunner = AdapterRunner;

const codexProviderConfig: AdapterProviderConfig<CodexProviderErrorCode, CodexProviderError> = {
  providerName: 'codex',
  providerDisplayName: 'Codex',
  adapterName: 'codex-v1',
  codes: {
    invalidOptions: 'CODEX_INVALID_OPTIONS',
    invalidEvent: 'CODEX_INVALID_EVENT',
    missingResult: 'CODEX_MISSING_RESULT',
    runFailed: 'CODEX_RUN_FAILED',
  } as const,
  createError: (code, message, details, cause) => new CodexProviderError(code, message, details, cause),
  isProviderError: (error: unknown): error is CodexProviderError => error instanceof CodexProviderError,
};

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;
  readonly #runner: CodexRunner;

  constructor(runner: CodexRunner = createDefaultAdapterRunner(codexProviderConfig.adapterName)) {
    this.#runner = runner;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    yield* runAdapterProvider(prompt, options, this.#runner, codexProviderConfig);
  }
}
