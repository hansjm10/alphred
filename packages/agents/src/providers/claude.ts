import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from '../provider.js';
import {
  type AdapterProviderConfig,
  type AdapterRawEvent,
  type AdapterRunRequest,
  type AdapterRunner,
  createDefaultAdapterRunner,
  runAdapterProvider,
} from './adapterProviderCore.js';
import {
  ClaudeBootstrapError,
  type ClaudeSdkBootstrap,
  initializeClaudeSdkBootstrap,
} from './claudeSdkBootstrap.js';

const claudeEventTypeAliases: Readonly<Record<string, ProviderEvent['type']>> = Object.freeze({
  text: 'assistant',
});

export type ClaudeProviderErrorCode =
  | 'CLAUDE_AUTH_ERROR'
  | 'CLAUDE_INVALID_CONFIG'
  | 'CLAUDE_INVALID_OPTIONS'
  | 'CLAUDE_INVALID_EVENT'
  | 'CLAUDE_MISSING_RESULT'
  | 'CLAUDE_RUN_FAILED'
  | 'CLAUDE_INTERNAL_ERROR';

type ClaudeFailureClass = 'auth' | 'config' | 'internal';

type ClaudeFailureClassification = Readonly<{
  code: ClaudeProviderErrorCode;
  classification: ClaudeFailureClass;
  retryable: boolean;
}>;

export class ClaudeProviderError extends Error {
  readonly code: ClaudeProviderErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    code: ClaudeProviderErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ClaudeProviderError';
    this.code = code;
    this.retryable = typeof details?.retryable === 'boolean' ? details.retryable : false;
    this.details = details;
    this.cause = cause;
  }
}

export type ClaudeRunRequest = AdapterRunRequest;
export type ClaudeRawEvent = AdapterRawEvent;
export type ClaudeRunner = AdapterRunner;
export type ClaudeBootstrapper = () => ClaudeSdkBootstrap;

const claudeProviderConfig: AdapterProviderConfig<ClaudeProviderErrorCode, ClaudeProviderError> = {
  providerName: 'claude',
  providerDisplayName: 'Claude',
  adapterName: 'claude-v1',
  codes: {
    invalidOptions: 'CLAUDE_INVALID_OPTIONS',
    invalidEvent: 'CLAUDE_INVALID_EVENT',
    missingResult: 'CLAUDE_MISSING_RESULT',
    runFailed: 'CLAUDE_RUN_FAILED',
  } as const,
  createError: (code, message, details, cause) => new ClaudeProviderError(code, message, details, cause),
  isProviderError: (error: unknown): error is ClaudeProviderError => error instanceof ClaudeProviderError,
  eventTypeAliases: claudeEventTypeAliases,
};

function classifyBootstrapError(error: ClaudeBootstrapError): ClaudeFailureClassification {
  switch (error.code) {
    case 'CLAUDE_BOOTSTRAP_MISSING_AUTH':
      return {
        code: 'CLAUDE_AUTH_ERROR',
        classification: 'auth',
        retryable: false,
      };
    case 'CLAUDE_BOOTSTRAP_INVALID_CONFIG':
    case 'CLAUDE_BOOTSTRAP_UNSUPPORTED_AUTH_MODE':
      return {
        code: 'CLAUDE_INVALID_CONFIG',
        classification: 'config',
        retryable: false,
      };
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  readonly #runner?: ClaudeRunner;
  readonly #bootstrap: ClaudeBootstrapper;

  constructor(
    runner?: ClaudeRunner,
    bootstrap: ClaudeBootstrapper = initializeClaudeSdkBootstrap,
  ) {
    this.#runner = runner;
    this.#bootstrap = bootstrap;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    try {
      this.#bootstrap();
    } catch (error) {
      if (error instanceof ClaudeBootstrapError) {
        const classification = classifyBootstrapError(error);
        throw new ClaudeProviderError(
          classification.code,
          error.message,
          {
            bootstrapCode: error.code,
            classification: classification.classification,
            retryable: classification.retryable,
            ...error.details,
          },
          error.cause ?? error,
        );
      }

      throw new ClaudeProviderError(
        'CLAUDE_INTERNAL_ERROR',
        'Claude provider bootstrap failed with an unknown internal error.',
        {
          classification: 'internal',
          retryable: false,
        },
        error,
      );
    }

    const runner = this.#runner ?? createDefaultAdapterRunner(claudeProviderConfig.adapterName);
    yield* runAdapterProvider(prompt, options, runner, claudeProviderConfig);
  }
}
