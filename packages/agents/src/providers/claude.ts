import { query, type Options as ClaudeQueryOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from '../provider.js';
import {
  type AdapterProviderConfig,
  type AdapterRawEvent,
  type AdapterRunRequest,
  type AdapterRunner,
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

const objectWithHasOwn = Object as ObjectConstructor & {
  hasOwn(object: object, property: PropertyKey): boolean;
};

export type ClaudeProviderErrorCode =
  | 'CLAUDE_AUTH_ERROR'
  | 'CLAUDE_INVALID_CONFIG'
  | 'CLAUDE_INVALID_OPTIONS'
  | 'CLAUDE_INVALID_EVENT'
  | 'CLAUDE_MISSING_RESULT'
  | 'CLAUDE_TIMEOUT'
  | 'CLAUDE_RATE_LIMITED'
  | 'CLAUDE_TRANSPORT_ERROR'
  | 'CLAUDE_INTERNAL_ERROR';

type ClaudeFailureClass = 'auth' | 'config' | 'timeout' | 'rate_limit' | 'transport' | 'internal';

type ClaudeFailureClassification = Readonly<{
  code: ClaudeProviderErrorCode;
  classification: ClaudeFailureClass;
  retryable: boolean;
  statusCode?: number;
  failureCode?: string;
}>;

function isRetryableClaudeErrorCode(code: ClaudeProviderErrorCode): boolean {
  return code === 'CLAUDE_TIMEOUT' || code === 'CLAUDE_RATE_LIMITED' || code === 'CLAUDE_TRANSPORT_ERROR';
}

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
    this.retryable = typeof details?.retryable === 'boolean' ? details.retryable : isRetryableClaudeErrorCode(code);
    this.details = details;
    this.cause = cause;
  }
}

export type ClaudeRunRequest = AdapterRunRequest;
export type ClaudeRawEvent = AdapterRawEvent;
export type ClaudeRunner = AdapterRunner;
export type ClaudeBootstrapper = () => ClaudeSdkBootstrap;
export type ClaudeSdkQuery = typeof query;

const claudeProviderConfig: AdapterProviderConfig<ClaudeProviderErrorCode, ClaudeProviderError> = {
  providerName: 'claude',
  providerDisplayName: 'Claude',
  adapterName: 'claude-v1',
  codes: {
    invalidOptions: 'CLAUDE_INVALID_OPTIONS',
    invalidEvent: 'CLAUDE_INVALID_EVENT',
    missingResult: 'CLAUDE_MISSING_RESULT',
    runFailed: 'CLAUDE_INTERNAL_ERROR',
  } as const,
  createError: (code, message, details, cause) => new ClaudeProviderError(code, message, details, cause),
  isProviderError: (error: unknown): error is ClaudeProviderError => error instanceof ClaudeProviderError,
  eventTypeAliases: claudeEventTypeAliases,
};

type ClaudeStreamState = {
  lastAssistantMessage: string;
  toolUseIds: Set<string>;
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toRecordOrThrow(value: unknown, eventIndex: number, fieldPath: string): Record<string, unknown> {
  const record = toRecord(value);
  if (record) {
    return record;
  }

  throw createClaudeInvalidEventError(
    `Claude emitted malformed stream data for "${fieldPath}" at event #${eventIndex}.`,
    {
      eventIndex,
      fieldPath,
      value,
    },
  );
}

function toString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value;
}

function toTrimmedString(value: unknown): string | undefined {
  const stringValue = toString(value);
  if (stringValue === undefined) {
    return undefined;
  }

  const trimmed = stringValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringOrThrow(value: unknown, eventIndex: number, fieldPath: string): string {
  const normalizedValue = toString(value);
  if (normalizedValue !== undefined) {
    return normalizedValue;
  }

  throw createClaudeInvalidEventError(
    `Claude emitted an invalid string for "${fieldPath}" at event #${eventIndex}.`,
    {
      eventIndex,
      fieldPath,
      value,
    },
  );
}

function toNonBlankStringOrThrow(value: unknown, eventIndex: number, fieldPath: string): string {
  const normalizedValue = toString(value);
  if (normalizedValue !== undefined && normalizedValue.trim().length > 0) {
    return normalizedValue;
  }

  throw createClaudeInvalidEventError(
    `Claude emitted an invalid string for "${fieldPath}" at event #${eventIndex}.`,
    {
      eventIndex,
      fieldPath,
      value,
    },
  );
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  // Failure payloads may surface HTTP status codes as numeric strings.
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numericValue = Number(value);
    if (Number.isInteger(numericValue) && numericValue >= 0) {
      return numericValue;
    }
  }

  return undefined;
}

function readRequiredTokenCount(
  usage: Record<string, unknown>,
  keys: readonly string[],
  eventIndex: number,
  fieldPath: string,
): number {
  for (const key of keys) {
    const tokenCount = toNonNegativeNumber(usage[key]);
    if (tokenCount !== undefined) {
      return tokenCount;
    }
  }

  throw createClaudeInvalidEventError(
    `Claude emitted invalid usage token metadata for "${fieldPath}" at event #${eventIndex}.`,
    {
      eventIndex,
      fieldPath,
      usage,
    },
  );
}

function readOptionalTokenCount(usage: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const tokenCount = toNonNegativeNumber(usage[key]);
    if (tokenCount !== undefined) {
      return tokenCount;
    }
  }

  return undefined;
}

function createUsageMetadata(usage: Record<string, unknown>, eventIndex: number): Record<string, unknown> {
  const inputTokens = readRequiredTokenCount(usage, ['input_tokens', 'inputTokens'], eventIndex, 'event.usage.input_tokens');
  const outputTokens = readRequiredTokenCount(usage, ['output_tokens', 'outputTokens'], eventIndex, 'event.usage.output_tokens');
  const cacheReadInputTokens = readOptionalTokenCount(usage, ['cache_read_input_tokens', 'cacheReadInputTokens']);
  const cacheCreationInputTokens = readOptionalTokenCount(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens']);

  const totalTokens = inputTokens + outputTokens;
  const normalizedUsage: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };

  const metadata: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    usage: normalizedUsage,
  };

  if (cacheReadInputTokens !== undefined) {
    normalizedUsage.cache_read_input_tokens = cacheReadInputTokens;
    metadata.cache_read_input_tokens = cacheReadInputTokens;
  }

  if (cacheCreationInputTokens !== undefined) {
    normalizedUsage.cache_creation_input_tokens = cacheCreationInputTokens;
    metadata.cache_creation_input_tokens = cacheCreationInputTokens;
  }

  return metadata;
}

function createClaudeInvalidEventError(message: string, details?: Record<string, unknown>): ClaudeProviderError {
  return new ClaudeProviderError('CLAUDE_INVALID_EVENT', message, details);
}

function collectFailureRecords(source: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const sourceRecord = toRecord(source);
  if (sourceRecord) {
    records.push(sourceRecord);
    const nestedError = toRecord(sourceRecord.error);
    if (nestedError) {
      records.push(nestedError);
    }
    const nestedCause = toRecord(sourceRecord.cause);
    if (nestedCause) {
      records.push(nestedCause);
    }
  }

  if (source instanceof Error) {
    const errorRecord = toRecord(source as unknown);
    if (errorRecord) {
      records.push(errorRecord);
    }
  }

  return records;
}

function extractFailureStatusCode(records: readonly Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const candidates = [
      record.status,
      record.statusCode,
      record.status_code,
      record.httpStatus,
      record.http_status,
    ];
    for (const candidate of candidates) {
      const statusCode = toNonNegativeInteger(candidate);
      if (statusCode !== undefined) {
        return statusCode;
      }
    }
  }

  return undefined;
}

function extractFailureCode(records: readonly Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    const structuredCodeCandidates = [record.code, record.error_code, record.errorCode];
    for (const candidate of structuredCodeCandidates) {
      const failureCode = toTrimmedString(candidate);
      if (failureCode) {
        return failureCode;
      }
    }
  }

  const genericMessageTypes = new Set([
    // SDK envelope message types are not stable failure codes (e.g., "result").
    'assistant',
    'auth_status',
    'result',
    'stream_event',
    'system',
    'task_notification',
    'tool_progress',
    'tool_use_summary',
    'user',
  ]);

  for (const record of records) {
    const fallbackCodeCandidates = [record.type, record.name];
    for (const candidate of fallbackCodeCandidates) {
      const failureCode = toTrimmedString(candidate);
      if (failureCode && !genericMessageTypes.has(failureCode.toLowerCase())) {
        return failureCode;
      }
    }
  }

  return undefined;
}

function collectFailureMessages(records: readonly Record<string, unknown>[]): string[] {
  const directFailureMessageFields = ['message', 'detail', 'error', 'cause'] as const;
  const messages: string[] = [];

  const appendFailureMessage = (value: unknown): void => {
    const normalizedMessage = toTrimmedString(value);
    if (normalizedMessage) {
      messages.push(normalizedMessage);
    }
  };

  for (const record of records) {
    for (const field of directFailureMessageFields) {
      appendFailureMessage(record[field]);
    }

    const errors = record.errors;
    if (Array.isArray(errors)) {
      for (const errorMessage of errors) {
        appendFailureMessage(errorMessage);
      }
    }
  }

  return messages;
}

const rateLimitPatterns: readonly RegExp[] = [
  /\brate[\s_-]?limit(?:ed|ing)?\b/i,
  /\brate[\s_-]?limit[\s_-]?exceeded\b/i,
  /\btoo many requests?\b/i,
  /\bquota\b/i,
  /\bthrottl(?:e|ed|ing)\b/i,
  /\bslow down\b/i,
];

function isRateLimitText(textCorpus: string): boolean {
  return rateLimitPatterns.some((pattern) => pattern.test(textCorpus));
}

function classifyClaudeFailure(message: string, source?: unknown): ClaudeFailureClassification {
  const records = collectFailureRecords(source);
  const statusCode = extractFailureStatusCode(records);
  const failureCode = extractFailureCode(records);
  const textCorpus = [message, failureCode, ...collectFailureMessages(records)].join(' ').toLowerCase();

  const isAuth = statusCode === 401
    || statusCode === 403
    || /\b(authentication_failed|billing_error|unauthorized|forbidden|authentication|invalid api key|permission denied|missing auth)\b/i.test(
      textCorpus,
    );
  if (isAuth) {
    return {
      code: 'CLAUDE_AUTH_ERROR',
      classification: 'auth',
      retryable: false,
      statusCode,
      failureCode,
    };
  }

  const isRateLimited = statusCode === 429 || isRateLimitText(textCorpus);
  if (isRateLimited) {
    return {
      code: 'CLAUDE_RATE_LIMITED',
      classification: 'rate_limit',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  const isTimeout = statusCode === 408
    || statusCode === 504
    || /\b(timeout|timed out|timedout|etimedout|deadline exceeded|time limit exceeded|operation timed out|request timed out)\b/i.test(
      textCorpus,
    );
  if (isTimeout) {
    return {
      code: 'CLAUDE_TIMEOUT',
      classification: 'timeout',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  const isTransport = /\b(econnreset|econnrefused|ehostunreach|enetunreach|enotfound|eai_again|socket|broken pipe|network error|connection reset|connection refused|transport)\b/i.test(
    textCorpus,
  );
  if (isTransport) {
    return {
      code: 'CLAUDE_TRANSPORT_ERROR',
      classification: 'transport',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  const isInternal = (statusCode !== undefined && statusCode >= 500 && statusCode < 600)
    || /\b(internal server error|unexpected error|panic|error_during_execution|server[\s_-]?error)\b/i.test(textCorpus);

  return {
    code: 'CLAUDE_INTERNAL_ERROR',
    classification: 'internal',
    retryable: isInternal,
    statusCode,
    failureCode,
  };
}

function createClaudeFailureError(message: string, details: Record<string, unknown> = {}, source?: unknown): ClaudeProviderError {
  const classification = classifyClaudeFailure(message, source);
  return new ClaudeProviderError(
    classification.code,
    message,
    {
      ...details,
      classification: classification.classification,
      retryable: classification.retryable,
      statusCode: classification.statusCode,
      failureCode: classification.failureCode,
    },
    source,
  );
}

function mapAuthStatusMessage(sdkMessage: Record<string, unknown>, eventIndex: number): ClaudeRawEvent[] {
  const authStatusError = toTrimmedString(sdkMessage.error);
  if (!authStatusError) {
    return [];
  }

  throw new ClaudeProviderError(
    'CLAUDE_AUTH_ERROR',
    `Claude authentication failed: ${authStatusError}`,
    {
      classification: 'auth',
      retryable: false,
      eventIndex,
      authStatusError,
    },
    sdkMessage,
  );
}

type AssistantContentBlockMapping = Readonly<{
  assistantText?: string;
  events: ClaudeRawEvent[];
}>;

function mapAssistantTextBlock(
  block: Record<string, unknown>,
  eventIndex: number,
  blockPath: string,
): AssistantContentBlockMapping {
  const text = toStringOrThrow(block.text, eventIndex, `${blockPath}.text`);
  return {
    assistantText: text,
    events: [
      {
        type: 'assistant',
        content: text,
      },
    ],
  };
}

function mapAssistantToolUseBlock(
  block: Record<string, unknown>,
  state: ClaudeStreamState,
  eventIndex: number,
  blockPath: string,
): AssistantContentBlockMapping {
  const toolName = toNonBlankStringOrThrow(block.name, eventIndex, `${blockPath}.name`);
  const toolUseId = toNonBlankStringOrThrow(block.id, eventIndex, `${blockPath}.id`);
  if (state.toolUseIds.has(toolUseId)) {
    return { events: [] };
  }

  state.toolUseIds.add(toolUseId);
  return {
    events: [
      {
        type: 'tool_use',
        content: toolName,
        metadata: {
          toolName,
          toolUseId,
          input: block.input,
        },
      },
    ],
  };
}

function mapAssistantToolResultBlock(block: Record<string, unknown>): AssistantContentBlockMapping {
  return {
    events: [
      {
        type: 'tool_result',
        content: block.content,
        metadata: {
          toolUseId: toTrimmedString(block.tool_use_id),
          isError: block.is_error,
        },
      },
    ],
  };
}

function mapAssistantThinkingBlock(block: Record<string, unknown>, blockType: string): AssistantContentBlockMapping {
  const thinkingText = toTrimmedString(block.text);
  if (!thinkingText) {
    return { events: [] };
  }

  return {
    events: [
      {
        type: 'system',
        content: thinkingText,
        metadata: {
          contentBlockType: blockType,
        },
      },
    ],
  };
}

function mapAssistantContentBlock(
  contentBlock: unknown,
  state: ClaudeStreamState,
  eventIndex: number,
  blockIndex: number,
): AssistantContentBlockMapping {
  const blockPath = `event.message.content[${blockIndex}]`;
  const block = toRecordOrThrow(contentBlock, eventIndex, blockPath);
  const blockType = toNonBlankStringOrThrow(block.type, eventIndex, `${blockPath}.type`);

  switch (blockType) {
    case 'text':
      return mapAssistantTextBlock(block, eventIndex, blockPath);
    case 'tool_use':
      return mapAssistantToolUseBlock(block, state, eventIndex, blockPath);
    case 'tool_result':
      return mapAssistantToolResultBlock(block);
    case 'thinking':
    case 'redacted_thinking':
      return mapAssistantThinkingBlock(block, blockType);
    default:
      return { events: [] };
  }
}

function mapAssistantMessage(sdkMessage: Record<string, unknown>, state: ClaudeStreamState, eventIndex: number): ClaudeRawEvent[] {
  const assistantError = toTrimmedString(sdkMessage.error);
  if (assistantError) {
    throw createClaudeFailureError(
      `Claude assistant stream failed: ${assistantError}`,
      {
        eventIndex,
        assistantError,
      },
      sdkMessage,
    );
  }

  const message = toRecordOrThrow(sdkMessage.message, eventIndex, 'event.message');
  const content = message.content;
  if (!Array.isArray(content)) {
    throw createClaudeInvalidEventError(
      `Claude emitted non-array assistant content at event #${eventIndex}.`,
      {
        eventIndex,
        fieldPath: 'event.message.content',
        value: content,
      },
    );
  }

  const mappedEvents: ClaudeRawEvent[] = [];
  const assistantTextBlocks: string[] = [];

  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const mappedBlock = mapAssistantContentBlock(content[blockIndex], state, eventIndex, blockIndex);
    if (mappedBlock.assistantText !== undefined) {
      assistantTextBlocks.push(mappedBlock.assistantText);
    }
    mappedEvents.push(...mappedBlock.events);
  }

  if (assistantTextBlocks.length > 0) {
    state.lastAssistantMessage = assistantTextBlocks.join('');
  }

  return mappedEvents;
}

function mapUserMessage(sdkMessage: Record<string, unknown>): ClaudeRawEvent[] {
  if (!objectWithHasOwn.hasOwn(sdkMessage, 'tool_use_result')) {
    return [];
  }

  return [
    {
      type: 'tool_result',
      content: sdkMessage.tool_use_result,
      metadata: {
        parentToolUseId: toTrimmedString(sdkMessage.parent_tool_use_id),
      },
    },
  ];
}

function mapToolProgressMessage(sdkMessage: Record<string, unknown>, state: ClaudeStreamState, eventIndex: number): ClaudeRawEvent[] {
  const toolName = toNonBlankStringOrThrow(sdkMessage.tool_name, eventIndex, 'event.tool_name');
  const toolUseId = toNonBlankStringOrThrow(sdkMessage.tool_use_id, eventIndex, 'event.tool_use_id');

  if (state.toolUseIds.has(toolUseId)) {
    return [];
  }

  state.toolUseIds.add(toolUseId);

  return [
    {
      type: 'tool_use',
      content: toolName,
      metadata: {
        toolName,
        toolUseId,
        parentToolUseId: toTrimmedString(sdkMessage.parent_tool_use_id),
        elapsedTimeSeconds: toNonNegativeNumber(sdkMessage.elapsed_time_seconds),
      },
    },
  ];
}

function mapToolUseSummaryMessage(sdkMessage: Record<string, unknown>, eventIndex: number): ClaudeRawEvent[] {
  const summary = toStringOrThrow(sdkMessage.summary, eventIndex, 'event.summary');
  const precedingToolUseIds = Array.isArray(sdkMessage.preceding_tool_use_ids)
    ? sdkMessage.preceding_tool_use_ids.filter((value): value is string => toTrimmedString(value) !== undefined)
    : [];

  return [
    {
      type: 'tool_result',
      content: summary,
      metadata: {
        precedingToolUseIds,
      },
    },
  ];
}

function mapResultMessage(sdkMessage: Record<string, unknown>, state: ClaudeStreamState, eventIndex: number): ClaudeRawEvent[] {
  const subtype = toNonBlankStringOrThrow(sdkMessage.subtype, eventIndex, 'event.subtype');

  if (subtype.startsWith('error_')) {
    const errors = Array.isArray(sdkMessage.errors)
      ? sdkMessage.errors.filter((value): value is string => toTrimmedString(value) !== undefined)
      : [];
    const failureMessage = errors[0]
      ?? `Claude reported a terminal result failure with subtype "${subtype}".`;

    throw createClaudeFailureError(
      `Claude run failed: ${failureMessage}`,
      {
        eventIndex,
        subtype,
        errors,
      },
      sdkMessage,
    );
  }

  if (subtype !== 'success') {
    throw createClaudeInvalidEventError(
      `Claude emitted unsupported result subtype "${subtype}" at event #${eventIndex}.`,
      {
        eventIndex,
        subtype,
      },
    );
  }

  const usage = toRecordOrThrow(sdkMessage.usage, eventIndex, 'event.usage');
  const usageMetadata = createUsageMetadata(usage, eventIndex);
  const result = toString(sdkMessage.result) ?? state.lastAssistantMessage;

  return [
    {
      type: 'usage',
      metadata: usageMetadata,
    },
    {
      type: 'result',
      content: result,
    },
  ];
}

function mapClaudeSdkMessage(sdkMessageValue: unknown, state: ClaudeStreamState, eventIndex: number): ClaudeRawEvent[] {
  const sdkMessage = toRecordOrThrow(sdkMessageValue, eventIndex, 'event');
  const messageType = toNonBlankStringOrThrow(sdkMessage.type, eventIndex, 'event.type');

  switch (messageType) {
    case 'assistant':
      return mapAssistantMessage(sdkMessage, state, eventIndex);
    case 'user':
      return mapUserMessage(sdkMessage);
    case 'tool_progress':
      return mapToolProgressMessage(sdkMessage, state, eventIndex);
    case 'tool_use_summary':
      return mapToolUseSummaryMessage(sdkMessage, eventIndex);
    case 'result':
      return mapResultMessage(sdkMessage, state, eventIndex);
    case 'auth_status':
      return mapAuthStatusMessage(sdkMessage, eventIndex);
    case 'system':
    case 'stream_event':
    case 'task_notification':
      return [];
    default:
      throw createClaudeInvalidEventError(
        `Claude emitted unsupported stream message type "${messageType}".`,
        {
          eventIndex,
          eventType: messageType,
        },
      );
  }
}

function createClaudeQueryEnvironment(bootstrap: ClaudeSdkBootstrap): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_API_KEY: bootstrap.apiKey,
    ANTHROPIC_API_KEY: bootstrap.apiKey,
  };

  if (bootstrap.baseUrl) {
    env.CLAUDE_BASE_URL = bootstrap.baseUrl;
    env.ANTHROPIC_BASE_URL = bootstrap.baseUrl;
  }

  return env;
}

function createClaudeQueryOptions(
  bootstrap: ClaudeSdkBootstrap,
  request: ClaudeRunRequest,
  abortController?: AbortController,
): ClaudeQueryOptions {
  const options: ClaudeQueryOptions = {
    cwd: request.workingDirectory,
    model: bootstrap.model,
    env: createClaudeQueryEnvironment(bootstrap),
  };

  if (abortController) {
    options.abortController = abortController;
  }

  return options;
}

function createClaudeSdkRunner(bootstrap: ClaudeSdkBootstrap, sdkQuery: ClaudeSdkQuery): ClaudeRunner {
  return async function* runClaudeSdk(request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
    const abortController = request.timeout === undefined ? undefined : new AbortController();
    const timeoutHandle = request.timeout === undefined
      ? undefined
      : setTimeout(() => {
        abortController?.abort();
      }, request.timeout);

    let stream: ReturnType<ClaudeSdkQuery> | undefined;
    let sdkEventIndex = 0;
    try {
      stream = sdkQuery({
        prompt: request.bridgedPrompt,
        options: createClaudeQueryOptions(bootstrap, request, abortController),
      });

      const state: ClaudeStreamState = {
        lastAssistantMessage: '',
        toolUseIds: new Set(),
      };

      for await (const sdkMessage of stream) {
        sdkEventIndex += 1;
        const mappedEvents = mapClaudeSdkMessage(sdkMessage, state, sdkEventIndex);
        for (const mappedEvent of mappedEvents) {
          yield mappedEvent;
        }
      }
    } catch (error) {
      if (error instanceof ClaudeProviderError) {
        throw error;
      }

      if (abortController?.signal.aborted && request.timeout !== undefined) {
        throw new ClaudeProviderError(
          'CLAUDE_TIMEOUT',
          `Claude provider run timed out after ${request.timeout} milliseconds.`,
          {
            classification: 'timeout',
            retryable: true,
            eventIndex: sdkEventIndex,
            timeout: request.timeout,
          },
          error,
        );
      }

      throw error;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }

      const queryStream = stream as { close?: () => void } | undefined;
      if (queryStream && typeof queryStream.close === 'function') {
        queryStream.close();
      }
    }
  };
}

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
  readonly #sdkQuery: ClaudeSdkQuery;

  constructor(
    runner?: ClaudeRunner,
    bootstrap: ClaudeBootstrapper = initializeClaudeSdkBootstrap,
    sdkQuery: ClaudeSdkQuery = query,
  ) {
    this.#runner = runner;
    this.#bootstrap = bootstrap;
    this.#sdkQuery = sdkQuery;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    let bootstrap: ClaudeSdkBootstrap;

    try {
      bootstrap = this.#bootstrap();
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

    const runner = this.#runner ?? createClaudeSdkRunner(bootstrap, this.#sdkQuery);
    try {
      yield* runAdapterProvider(prompt, options, runner, claudeProviderConfig);
    } catch (error) {
      if (error instanceof ClaudeProviderError && error.code === 'CLAUDE_INTERNAL_ERROR' && error.details?.classification === undefined) {
        throw createClaudeFailureError(
          error.message,
          error.details ?? {},
          error.cause ?? error,
        );
      }

      throw error;
    }
  }
}
