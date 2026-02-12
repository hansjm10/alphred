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

const claudeEventTypeAliases: Readonly<Record<string, ProviderEvent['type']>> = Object.freeze({
  text: 'assistant',
});

export type ClaudeProviderErrorCode =
  | 'CLAUDE_INVALID_OPTIONS'
  | 'CLAUDE_INVALID_EVENT'
  | 'CLAUDE_MISSING_RESULT'
  | 'CLAUDE_RUN_FAILED';

export class ClaudeProviderError extends Error {
  readonly code: ClaudeProviderErrorCode;
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
    this.details = details;
    this.cause = cause;
  }
}

export type ClaudeRunRequest = AdapterRunRequest;
export type ClaudeRawEvent = AdapterRawEvent;
export type ClaudeRunner = AdapterRunner;

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

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  readonly #runner: ClaudeRunner;

  constructor(runner: ClaudeRunner = createDefaultAdapterRunner(claudeProviderConfig.adapterName)) {
    this.#runner = runner;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    yield* runAdapterProvider(prompt, options, this.#runner, claudeProviderConfig);
  }
}
