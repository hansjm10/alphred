import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from '../provider.js';
import { createProviderEvent } from '../provider.js';

const providerEventTypeAliases: Readonly<Record<string, ProviderEvent['type']>> = Object.freeze({
  final: 'result',
  message: 'assistant',
  'tool-use': 'tool_use',
  toolUse: 'tool_use',
  'tool-result': 'tool_result',
  toolResult: 'tool_result',
});

const supportedProviderEventTypes = new Set<ProviderEvent['type']>([
  'system',
  'assistant',
  'result',
  'tool_use',
  'tool_result',
  'usage',
]);

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

export type CodexRunRequest = Readonly<{
  prompt: string;
  bridgedPrompt: string;
  workingDirectory: string;
  context: readonly string[];
  systemPrompt?: string;
  maxTokens?: number;
  timeout?: number;
}>;

export type CodexRawEvent = Readonly<{
  type: string;
  content?: unknown;
  metadata?: unknown;
}>;

export type CodexRunner = (request: CodexRunRequest) => AsyncIterable<CodexRawEvent>;

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function toMetadataRecord(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  return { ...(metadata as Record<string, unknown>) };
}

function firstTokenCount(metadata: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const tokenCount = toNonNegativeNumber(metadata[key]);
    if (tokenCount !== undefined) {
      return tokenCount;
    }
  }

  return undefined;
}

function normalizeUsageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const nestedUsage = toMetadataRecord(metadata.usage);
  const inputTokens =
    firstTokenCount(metadata, ['input_tokens', 'inputTokens']) ??
    (nestedUsage ? firstTokenCount(nestedUsage, ['input_tokens', 'inputTokens']) : undefined);
  const outputTokens =
    firstTokenCount(metadata, ['output_tokens', 'outputTokens']) ??
    (nestedUsage ? firstTokenCount(nestedUsage, ['output_tokens', 'outputTokens']) : undefined);
  const directTotalTokens =
    firstTokenCount(metadata, ['total_tokens', 'totalTokens', 'tokensUsed']) ??
    (nestedUsage ? firstTokenCount(nestedUsage, ['total_tokens', 'totalTokens', 'tokensUsed']) : undefined);
  const totalTokens = directTotalTokens ?? (inputTokens !== undefined && outputTokens !== undefined
    ? inputTokens + outputTokens
    : undefined);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return metadata;
  }

  const normalizedUsage: Record<string, unknown> = {
    ...(nestedUsage ?? {}),
  };
  if (inputTokens !== undefined) {
    normalizedUsage.input_tokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    normalizedUsage.output_tokens = outputTokens;
  }
  if (totalTokens !== undefined) {
    normalizedUsage.total_tokens = totalTokens;
  }

  const normalizedMetadata: Record<string, unknown> = {
    ...metadata,
    usage: normalizedUsage,
  };
  if (inputTokens !== undefined) {
    normalizedMetadata.input_tokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    normalizedMetadata.output_tokens = outputTokens;
  }
  if (totalTokens !== undefined) {
    normalizedMetadata.total_tokens = totalTokens;
  }

  return normalizedMetadata;
}

function normalizeEventType(rawType: string): ProviderEvent['type'] | undefined {
  if (supportedProviderEventTypes.has(rawType as ProviderEvent['type'])) {
    return rawType as ProviderEvent['type'];
  }

  return providerEventTypeAliases[rawType];
}

function normalizeEventContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (content === undefined || content === null) {
    return '';
  }

  const serializedContent = JSON.stringify(content);
  return serializedContent ?? String(content);
}

function normalizeEventMetadata(eventType: ProviderEvent['type'], metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const normalizedMetadata = toMetadataRecord(metadata);
  if (!normalizedMetadata) {
    return { value: metadata };
  }

  if (eventType !== 'usage') {
    return normalizedMetadata;
  }

  return normalizeUsageMetadata(normalizedMetadata);
}

function normalizeRawEvent(rawEvent: CodexRawEvent, eventIndex: number): ProviderEvent {
  const normalizedType = normalizeEventType(rawEvent.type);
  if (!normalizedType) {
    throw new CodexProviderError('CODEX_INVALID_EVENT', `Codex emitted unsupported event type "${rawEvent.type}".`, {
      eventIndex,
      eventType: rawEvent.type,
    });
  }

  return createProviderEvent(
    normalizedType,
    normalizeEventContent(rawEvent.content),
    normalizeEventMetadata(normalizedType, rawEvent.metadata),
  );
}

function normalizeContext(context: ProviderRunOptions['context']): string[] {
  if (!context) {
    return [];
  }

  return context.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function buildBridgedPrompt(prompt: string, options: ProviderRunOptions, context: readonly string[]): string {
  const systemPrompt = options.systemPrompt?.trim();
  if (!systemPrompt && context.length === 0) {
    return prompt;
  }

  const sections: string[] = [];
  if (systemPrompt) {
    sections.push(`System prompt:\n${systemPrompt}`);
  }
  if (context.length > 0) {
    sections.push(`Context:\n${context.map((entry, index) => `[${index + 1}] ${entry}`).join('\n')}`);
  }
  sections.push(`User prompt:\n${prompt}`);

  return sections.join('\n\n');
}

function createRunRequest(prompt: string, options: ProviderRunOptions): CodexRunRequest {
  const workingDirectory = (options as { workingDirectory?: unknown }).workingDirectory;
  if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
    throw new CodexProviderError(
      'CODEX_INVALID_OPTIONS',
      'Codex provider requires a non-empty workingDirectory option.',
    );
  }

  if (
    options.maxTokens !== undefined &&
    (!Number.isInteger(options.maxTokens) || options.maxTokens <= 0)
  ) {
    throw new CodexProviderError('CODEX_INVALID_OPTIONS', 'Codex provider requires maxTokens to be a positive integer.', {
      maxTokens: options.maxTokens,
    });
  }

  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new CodexProviderError('CODEX_INVALID_OPTIONS', 'Codex provider requires timeout to be a positive number.', {
      timeout: options.timeout,
    });
  }

  const context = normalizeContext(options.context);

  return {
    prompt,
    bridgedPrompt: buildBridgedPrompt(prompt, options, context),
    workingDirectory,
    context,
    systemPrompt: options.systemPrompt?.trim() || undefined,
    maxTokens: options.maxTokens,
    timeout: options.timeout,
  };
}

async function* runCodexAdapterV1(request: CodexRunRequest): AsyncIterable<CodexRawEvent> {
  yield {
    type: 'assistant',
    content: '',
    metadata: {
      adapter: 'codex-v1',
      working_directory: request.workingDirectory,
    },
  };
  yield {
    type: 'usage',
    metadata: {
      input_tokens: request.bridgedPrompt.length,
      output_tokens: 0,
      total_tokens: request.bridgedPrompt.length,
    },
  };
  yield {
    type: 'result',
    content: '',
  };
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const;
  readonly #runner: CodexRunner;

  constructor(runner: CodexRunner = runCodexAdapterV1) {
    this.#runner = runner;
  }

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    const request = createRunRequest(prompt, options);

    yield createProviderEvent('system', 'Codex provider run started.', {
      provider: this.name,
      workingDirectory: request.workingDirectory,
      hasSystemPrompt: request.systemPrompt !== undefined,
      contextItemCount: request.context.length,
      maxTokens: request.maxTokens,
      timeout: request.timeout,
    });

    let eventIndex = 0;
    let resultSeen = false;

    try {
      for await (const rawEvent of this.#runner(request)) {
        eventIndex += 1;
        const event = normalizeRawEvent(rawEvent, eventIndex);

        if (resultSeen) {
          throw new CodexProviderError(
            'CODEX_INVALID_EVENT',
            'Codex emitted events after a result event, which violates provider ordering.',
            {
              eventIndex,
              eventType: event.type,
            },
          );
        }

        if (event.type === 'result') {
          resultSeen = true;
        }

        yield event;
      }
    } catch (error) {
      if (error instanceof CodexProviderError) {
        throw error;
      }

      throw new CodexProviderError(
        'CODEX_RUN_FAILED',
        'Codex provider run failed.',
        {
          workingDirectory: request.workingDirectory,
          eventIndex,
        },
        error,
      );
    }

    if (!resultSeen) {
      throw new CodexProviderError(
        'CODEX_MISSING_RESULT',
        'Codex provider completed without emitting a result event.',
        { eventCount: eventIndex },
      );
    }
  }
}
