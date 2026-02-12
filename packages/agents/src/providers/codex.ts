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
import { CodexBootstrapError, type CodexSdkBootstrap, initializeCodexSdkBootstrap } from './codexSdkBootstrap.js';

export type CodexProviderErrorCode =
  | 'CODEX_INVALID_CONFIG'
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
export type CodexBootstrapper = () => CodexSdkBootstrap;

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
  readonly #bootstrap: CodexBootstrapper;

  constructor(
    runner: CodexRunner = createDefaultAdapterRunner(codexProviderConfig.adapterName),
    bootstrap: CodexBootstrapper = initializeCodexSdkBootstrap,
  ) {
    this.#runner = runner;
    this.#bootstrap = bootstrap;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    try {
      this.#bootstrap();
    } catch (error) {
      if (error instanceof CodexBootstrapError) {
        throw new CodexProviderError(
          'CODEX_INVALID_CONFIG',
          error.message,
          {
            bootstrapCode: error.code,
            ...error.details,
          },
          error.cause ?? error,
        );
      }

      throw new CodexProviderError(
        'CODEX_INVALID_CONFIG',
        'Codex provider bootstrap failed with an unknown configuration error.',
        undefined,
        error,
      );
    }

    yield* runAdapterProvider(prompt, options, this.#runner, codexProviderConfig);
  }
}
