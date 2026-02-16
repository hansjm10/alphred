import { routingDecisionSignals, type ProviderRunOptions, type RoutingDecisionSignal } from '@alphred/shared';
import type { ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import type { AgentProvider } from '../provider.js';
import {
  type AdapterProviderConfig,
  type AdapterRawEvent,
  type AdapterRunRequest,
  type AdapterRunner,
  runAdapterProvider,
} from './adapterProviderCore.js';
import { CodexBootstrapError, type CodexSdkBootstrap, initializeCodexSdkBootstrap } from './codexSdkBootstrap.js';

export type CodexProviderErrorCode =
  | 'CODEX_AUTH_ERROR'
  | 'CODEX_INVALID_CONFIG'
  | 'CODEX_INVALID_OPTIONS'
  | 'CODEX_INVALID_EVENT'
  | 'CODEX_MISSING_RESULT'
  | 'CODEX_TIMEOUT'
  | 'CODEX_RATE_LIMITED'
  | 'CODEX_TRANSPORT_ERROR'
  | 'CODEX_INTERNAL_ERROR';

type CodexFailureClass = 'auth' | 'config' | 'timeout' | 'rate_limit' | 'transport' | 'internal';

type CodexFailureClassification = Readonly<{
  code: CodexProviderErrorCode;
  classification: CodexFailureClass;
  retryable: boolean;
  statusCode?: number;
  failureCode?: string;
}>;

function isRetryableCodexErrorCode(code: CodexProviderErrorCode): boolean {
  return code === 'CODEX_TIMEOUT' || code === 'CODEX_RATE_LIMITED' || code === 'CODEX_TRANSPORT_ERROR';
}

export class CodexProviderError extends Error {
  readonly code: CodexProviderErrorCode;
  readonly retryable: boolean;
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
    this.retryable = typeof details?.retryable === 'boolean' ? details.retryable : isRetryableCodexErrorCode(code);
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
    runFailed: 'CODEX_INTERNAL_ERROR',
  } as const,
  createError: (code, message, details, cause) => new CodexProviderError(code, message, details, cause),
  isProviderError: (error: unknown): error is CodexProviderError => error instanceof CodexProviderError,
};

type CodexItemLifecycle = 'started' | 'updated' | 'completed';

type CodexStreamState = {
  lastAssistantMessage: string;
};

const routingDecisionSignalSet: ReadonlySet<RoutingDecisionSignal> = new Set(routingDecisionSignals);

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return undefined;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRoutingDecisionSignal(value: unknown): RoutingDecisionSignal | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (!routingDecisionSignalSet.has(value as RoutingDecisionSignal)) {
    return undefined;
  }

  return value as RoutingDecisionSignal;
}

function readRoutingDecisionFromMetadataRecords(
  metadataRecords: readonly (Record<string, unknown> | undefined)[],
  key: 'routingDecision' | 'routing_decision',
): RoutingDecisionSignal | undefined {
  for (const metadataRecord of metadataRecords) {
    if (!metadataRecord) {
      continue;
    }

    const routingDecision = toRoutingDecisionSignal(metadataRecord[key]);
    if (routingDecision) {
      return routingDecision;
    }
  }

  return undefined;
}

function extractRoutingDecisionSignal(sdkEvent: Record<string, unknown>): RoutingDecisionSignal | undefined {
  const resultRecord = toRecord(sdkEvent.result);
  const metadataRecords: (Record<string, unknown> | undefined)[] = [
    sdkEvent,
    toRecord(sdkEvent.metadata),
    toRecord(sdkEvent.result_metadata),
    toRecord(sdkEvent.resultMetadata),
    resultRecord,
    resultRecord ? toRecord(resultRecord.metadata) : undefined,
  ];

  return readRoutingDecisionFromMetadataRecords(metadataRecords, 'routingDecision')
    ?? readRoutingDecisionFromMetadataRecords(metadataRecords, 'routing_decision');
}

function createResultMetadata(sdkEvent: Record<string, unknown>): Record<string, unknown> | undefined {
  const routingDecision = extractRoutingDecisionSignal(sdkEvent);
  if (!routingDecision) {
    return undefined;
  }

  return { routingDecision };
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
      const statusCode = toNumber(candidate);
      if (statusCode !== undefined) {
        return statusCode;
      }
    }
  }

  return undefined;
}

function extractFailureCode(records: readonly Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    const candidates = [
      record.code,
      record.error_code,
      record.errorCode,
      record.type,
      record.name,
    ];
    for (const candidate of candidates) {
      const failureCode = toTrimmedString(candidate);
      if (failureCode) {
        return failureCode;
      }
    }
  }

  return undefined;
}

function collectFailureMessages(records: readonly Record<string, unknown>[]): string[] {
  const messages: string[] = [];
  for (const record of records) {
    const message = toTrimmedString(record.message);
    if (message) {
      messages.push(message);
    }
    const detail = toTrimmedString(record.detail);
    if (detail) {
      messages.push(detail);
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

function classifyCodexFailure(message: string, source?: unknown): CodexFailureClassification {
  const records = collectFailureRecords(source);
  const statusCode = extractFailureStatusCode(records);
  const failureCode = extractFailureCode(records);
  const textCorpus = [message, failureCode, ...collectFailureMessages(records)].join(' ').toLowerCase();

  const isAuth = statusCode === 401
    || statusCode === 403
    || /\b(unauthorized|forbidden|authentication|invalid api key|not logged in|permission denied|missing auth)\b/i.test(
      textCorpus,
    );
  if (isAuth) {
    return {
      code: 'CODEX_AUTH_ERROR',
      classification: 'auth',
      retryable: false,
      statusCode,
      failureCode,
    };
  }

  const isRateLimited = statusCode === 429
    || isRateLimitText(textCorpus);
  if (isRateLimited) {
    return {
      code: 'CODEX_RATE_LIMITED',
      classification: 'rate_limit',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  const isTimeout = statusCode === 408
    || statusCode === 504
    || /\b(timeout|timed out|timedout|etimedout|deadline exceeded|time limit exceeded|operation timed out|request timed out)\b/i.test(textCorpus);
  if (isTimeout) {
    return {
      code: 'CODEX_TIMEOUT',
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
      code: 'CODEX_TRANSPORT_ERROR',
      classification: 'transport',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  const isInternal = (statusCode !== undefined && statusCode >= 500 && statusCode < 600)
    || /\b(internal server error|unexpected error|panic)\b/i.test(textCorpus);
  if (isInternal) {
    return {
      code: 'CODEX_INTERNAL_ERROR',
      classification: 'internal',
      retryable: true,
      statusCode,
      failureCode,
    };
  }

  return {
    code: 'CODEX_INTERNAL_ERROR',
    classification: 'internal',
    retryable: false,
    statusCode,
    failureCode,
  };
}

function createCodexFailureError(message: string, details: Record<string, unknown>, source?: unknown): CodexProviderError {
  const classification = classifyCodexFailure(message, source);
  const classifiedDetails: Record<string, unknown> = {
    ...details,
    classification: classification.classification,
    retryable: classification.retryable,
  };
  if (classification.statusCode !== undefined) {
    classifiedDetails.statusCode = classification.statusCode;
  }
  if (classification.failureCode !== undefined) {
    classifiedDetails.failureCode = classification.failureCode;
  }

  return new CodexProviderError(classification.code, message, classifiedDetails, source);
}

function classifyBootstrapError(error: CodexBootstrapError): CodexFailureClassification {
  switch (error.code) {
    case 'CODEX_BOOTSTRAP_MISSING_AUTH':
      return {
        code: 'CODEX_AUTH_ERROR',
        classification: 'auth',
        retryable: false,
      };
    case 'CODEX_BOOTSTRAP_INVALID_CONFIG':
    case 'CODEX_BOOTSTRAP_SESSION_CHECK_FAILED':
    case 'CODEX_BOOTSTRAP_UNSUPPORTED_PLATFORM':
      return {
        code: 'CODEX_INVALID_CONFIG',
        classification: 'config',
        retryable: false,
      };
    case 'CODEX_BOOTSTRAP_CLIENT_INIT_FAILED':
      return {
        code: 'CODEX_INTERNAL_ERROR',
        classification: 'internal',
        retryable: false,
      };
  }
}

function createCodexInvalidEventError(message: string, details?: Record<string, unknown>): CodexProviderError {
  return codexProviderConfig.createError(codexProviderConfig.codes.invalidEvent, message, details);
}

function toRecordOrThrow(
  value: unknown,
  eventIndex: number,
  fieldPath: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createCodexInvalidEventError(
      `Codex emitted malformed event payload for "${fieldPath}".`,
      {
        eventIndex,
        fieldPath,
        value,
      },
    );
  }

  return value as Record<string, unknown>;
}

function toStringOrThrow(
  value: unknown,
  eventIndex: number,
  fieldPath: string,
): string {
  if (typeof value !== 'string') {
    throw createCodexInvalidEventError(
      `Codex emitted a non-string value for "${fieldPath}".`,
      {
        eventIndex,
        fieldPath,
        value,
      },
    );
  }

  return value;
}

function toNonNegativeNumberOrThrow(
  value: unknown,
  eventIndex: number,
  fieldPath: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw createCodexInvalidEventError(
      `Codex emitted an invalid numeric value for "${fieldPath}".`,
      {
        eventIndex,
        fieldPath,
        value,
      },
    );
  }

  return value;
}

function buildToolUseContent(itemType: string, itemRecord: Record<string, unknown>, eventIndex: number): unknown {
  switch (itemType) {
    case 'command_execution':
      return toStringOrThrow(itemRecord.command, eventIndex, 'item.command');
    case 'mcp_tool_call': {
      const server = toStringOrThrow(itemRecord.server, eventIndex, 'item.server');
      const tool = toStringOrThrow(itemRecord.tool, eventIndex, 'item.tool');
      return `${server}.${tool}`;
    }
    case 'web_search':
      return toStringOrThrow(itemRecord.query, eventIndex, 'item.query');
    case 'file_change': {
      const changes = itemRecord.changes;
      if (!Array.isArray(changes)) {
        throw createCodexInvalidEventError(
          'Codex emitted file_change item without a valid changes array.',
          {
            eventIndex,
            changes,
          },
        );
      }
      return `file_change:${changes.length}`;
    }
    case 'todo_list':
      return 'todo_list';
    default:
      throw createCodexInvalidEventError(
        `Codex emitted unsupported tool item type "${itemType}".`,
        {
          eventIndex,
          itemType,
        },
      );
  }
}

function buildToolResultContent(itemType: string, itemRecord: Record<string, unknown>, eventIndex: number): unknown {
  switch (itemType) {
    case 'command_execution': {
      const command = toStringOrThrow(itemRecord.command, eventIndex, 'item.command');
      const aggregatedOutput = itemRecord.aggregated_output;
      if (aggregatedOutput !== undefined && typeof aggregatedOutput !== 'string') {
        throw createCodexInvalidEventError(
          'Codex emitted command_execution item with invalid aggregated_output.',
          {
            eventIndex,
            aggregatedOutput,
          },
        );
      }

      return {
        command,
        output: aggregatedOutput ?? '',
        exit_code: itemRecord.exit_code,
      };
    }
    case 'mcp_tool_call': {
      const server = toStringOrThrow(itemRecord.server, eventIndex, 'item.server');
      const tool = toStringOrThrow(itemRecord.tool, eventIndex, 'item.tool');

      return {
        server,
        tool,
        result: itemRecord.result,
        error: itemRecord.error,
      };
    }
    case 'web_search':
      return {
        query: toStringOrThrow(itemRecord.query, eventIndex, 'item.query'),
      };
    case 'file_change': {
      const changes = itemRecord.changes;
      if (!Array.isArray(changes)) {
        throw createCodexInvalidEventError(
          'Codex emitted file_change item without a valid changes array.',
          {
            eventIndex,
            changes,
          },
        );
      }

      return changes;
    }
    case 'todo_list': {
      const items = itemRecord.items;
      if (!Array.isArray(items)) {
        throw createCodexInvalidEventError(
          'Codex emitted todo_list item without a valid items array.',
          {
            eventIndex,
            items,
          },
        );
      }

      return items;
    }
    default:
      throw createCodexInvalidEventError(
        `Codex emitted unsupported tool item type "${itemType}".`,
        {
          eventIndex,
          itemType,
        },
      );
  }
}

function mapItemLifecycleEvent(
  itemRecord: Record<string, unknown>,
  lifecycle: CodexItemLifecycle,
  state: CodexStreamState,
  eventIndex: number,
): CodexRawEvent[] {
  const itemType = toStringOrThrow(itemRecord.type, eventIndex, 'item.type');
  const itemId = itemRecord.id;

  const baseMetadata: Record<string, unknown> = {
    itemType,
    lifecycle,
    item: itemRecord,
  };
  if (typeof itemId === 'string') {
    baseMetadata.itemId = itemId;
  }

  if (itemType === 'agent_message') {
    if (lifecycle !== 'completed') {
      return [];
    }

    const text = toStringOrThrow(itemRecord.text, eventIndex, 'item.text');
    state.lastAssistantMessage = text;
    return [
      {
        type: 'assistant',
        content: text,
        metadata: baseMetadata,
      },
    ];
  }

  if (itemType === 'reasoning') {
    if (lifecycle !== 'completed') {
      return [];
    }

    return [
      {
        type: 'system',
        content: toStringOrThrow(itemRecord.text, eventIndex, 'item.text'),
        metadata: baseMetadata,
      },
    ];
  }

  if (itemType === 'error') {
    if (lifecycle !== 'completed') {
      return [];
    }

    return [
      {
        type: 'system',
        content: toStringOrThrow(itemRecord.message, eventIndex, 'item.message'),
        metadata: baseMetadata,
      },
    ];
  }

  if (
    itemType !== 'command_execution'
    && itemType !== 'mcp_tool_call'
    && itemType !== 'web_search'
    && itemType !== 'file_change'
    && itemType !== 'todo_list'
  ) {
    throw createCodexInvalidEventError(
      `Codex emitted unsupported item type "${itemType}" for "${lifecycle}".`,
      {
        eventIndex,
        itemType,
        lifecycle,
      },
    );
  }

  if (lifecycle === 'updated') {
    return [];
  }

  if (lifecycle === 'started') {
    return [
      {
        type: 'tool_use',
        content: buildToolUseContent(itemType, itemRecord, eventIndex),
        metadata: baseMetadata,
      },
    ];
  }

  return [
    {
      type: 'tool_result',
      content: buildToolResultContent(itemType, itemRecord, eventIndex),
      metadata: baseMetadata,
    },
  ];
}

function mapSdkStreamEvent(
  sdkEventValue: unknown,
  state: CodexStreamState,
  eventIndex: number,
): CodexRawEvent[] {
  const sdkEvent = toRecordOrThrow(sdkEventValue, eventIndex, 'event');
  const eventType = toStringOrThrow(sdkEvent.type, eventIndex, 'event.type');

  switch (eventType) {
    case 'thread.started':
      toStringOrThrow(sdkEvent.thread_id, eventIndex, 'event.thread_id');
      return [];
    case 'turn.started':
      return [];
    case 'item.started': {
      const item = toRecordOrThrow(sdkEvent.item, eventIndex, 'event.item');
      return mapItemLifecycleEvent(item, 'started', state, eventIndex);
    }
    case 'item.updated': {
      const item = toRecordOrThrow(sdkEvent.item, eventIndex, 'event.item');
      return mapItemLifecycleEvent(item, 'updated', state, eventIndex);
    }
    case 'item.completed': {
      const item = toRecordOrThrow(sdkEvent.item, eventIndex, 'event.item');
      return mapItemLifecycleEvent(item, 'completed', state, eventIndex);
    }
    case 'turn.completed': {
      const usage = toRecordOrThrow(sdkEvent.usage, eventIndex, 'event.usage');
      const inputTokens = toNonNegativeNumberOrThrow(usage.input_tokens, eventIndex, 'event.usage.input_tokens');
      const outputTokens = toNonNegativeNumberOrThrow(usage.output_tokens, eventIndex, 'event.usage.output_tokens');
      const cachedInputTokens = toNonNegativeNumberOrThrow(
        usage.cached_input_tokens,
        eventIndex,
        'event.usage.cached_input_tokens',
      );
      const resultMetadata = createResultMetadata(sdkEvent);

      return [
        {
          type: 'usage',
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_input_tokens: cachedInputTokens,
          },
        },
        {
          type: 'result',
          content: state.lastAssistantMessage,
          metadata: resultMetadata,
        },
      ];
    }
    case 'turn.failed': {
      const error = toRecordOrThrow(sdkEvent.error, eventIndex, 'event.error');
      throw createCodexFailureError(
        `Codex turn failed: ${toStringOrThrow(error.message, eventIndex, 'event.error.message')}`,
        {
          eventIndex,
          error,
        },
        error,
      );
    }
    case 'error':
      throw createCodexFailureError(
        `Codex stream emitted a fatal error: ${toStringOrThrow(sdkEvent.message, eventIndex, 'event.message')}`,
        {
          eventIndex,
          message: sdkEvent.message,
        },
        sdkEvent,
      );
    default:
      throw createCodexInvalidEventError(
        `Codex emitted unsupported stream event type "${eventType}".`,
        {
          eventIndex,
          eventType,
        },
      );
  }
}

function toThreadOptions(bootstrap: CodexSdkBootstrap, request: CodexRunRequest): ThreadOptions {
  return {
    model: bootstrap.model,
    workingDirectory: request.workingDirectory,
  };
}

function toTurnOptions(request: CodexRunRequest): TurnOptions | undefined {
  if (request.timeout === undefined) {
    return undefined;
  }

  return {
    signal: AbortSignal.timeout(request.timeout),
  };
}

function createCodexSdkRunner(bootstrap: CodexSdkBootstrap): CodexRunner {
  return async function* runCodexSdk(request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
    const thread = bootstrap.client.startThread(toThreadOptions(bootstrap, request));
    const streamedTurn = await thread.runStreamed(request.bridgedPrompt, toTurnOptions(request));
    const state: CodexStreamState = {
      lastAssistantMessage: '',
    };

    let sdkEventIndex = 0;
    for await (const sdkEvent of streamedTurn.events) {
      sdkEventIndex += 1;
      const mappedEvents = mapSdkStreamEvent(sdkEvent, state, sdkEventIndex);
      for (const mappedEvent of mappedEvents) {
        yield mappedEvent;
      }
    }
  };
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;
  readonly #runner?: CodexRunner;
  readonly #bootstrap: CodexBootstrapper;

  constructor(
    runner?: CodexRunner,
    bootstrap: CodexBootstrapper = initializeCodexSdkBootstrap,
  ) {
    this.#runner = runner;
    this.#bootstrap = bootstrap;
  }

  async *run(prompt: string, options: ProviderRunOptions) {
    let bootstrap: CodexSdkBootstrap;
    try {
      bootstrap = this.#bootstrap();
    } catch (error) {
      if (error instanceof CodexBootstrapError) {
        const classification = classifyBootstrapError(error);
        throw new CodexProviderError(
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

      throw new CodexProviderError(
        'CODEX_INTERNAL_ERROR',
        'Codex provider bootstrap failed with an unknown internal error.',
        {
          classification: 'internal',
          retryable: false,
        },
        error,
      );
    }

    const runner = this.#runner ?? createCodexSdkRunner(bootstrap);
    try {
      yield* runAdapterProvider(prompt, options, runner, codexProviderConfig);
    } catch (error) {
      if (error instanceof CodexProviderError && error.code === 'CODEX_INTERNAL_ERROR' && error.details?.classification === undefined) {
        throw createCodexFailureError(
          error.message,
          error.details ?? {},
          error.cause ?? error,
        );
      }

      throw error;
    }
  }
}
