import { inspect } from 'node:util';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from '../provider.js';
import { createProviderEvent } from '../provider.js';

const providerEventTypeAliases: Readonly<Record<string, ProviderEvent['type']>> = Object.freeze({
  final: 'result',
  message: 'assistant',
  text: 'assistant',
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

export type ClaudeRunRequest = Readonly<{
  prompt: string;
  bridgedPrompt: string;
  workingDirectory: string;
  context: readonly string[];
  systemPrompt?: string;
  maxTokens?: number;
  timeout?: number;
}>;

export type ClaudeRawEvent = Readonly<{
  type: string;
  content?: unknown;
  metadata?: unknown;
}>;

export type ClaudeRunner = (request: ClaudeRunRequest) => AsyncIterable<ClaudeRawEvent>;

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
  const totalTokens = directTotalTokens
    ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return metadata;
  }

  const normalizedUsage: Record<string, unknown> = nestedUsage ? { ...nestedUsage } : {};
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

  try {
    const serializedContent = JSON.stringify(content);
    if (serializedContent !== undefined) {
      return serializedContent;
    }
  } catch {
    // Fall through to inspect-based rendering for non-serializable values.
  }

  return inspect(content, { depth: null });
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

function normalizeRawEvent(rawEvent: ClaudeRawEvent, eventIndex: number): ProviderEvent {
  const normalizedType = normalizeEventType(rawEvent.type);
  if (!normalizedType) {
    throw new ClaudeProviderError(
      'CLAUDE_INVALID_EVENT',
      `Claude emitted unsupported event type "${rawEvent.type}".`,
      {
        eventIndex,
        eventType: rawEvent.type,
      },
    );
  }

  return createProviderEvent(
    normalizedType,
    normalizeEventContent(rawEvent.content),
    normalizeEventMetadata(normalizedType, rawEvent.metadata),
  );
}

function normalizeContext(context: ProviderRunOptions['context']): string[] {
  if (context === undefined) {
    return [];
  }

  if (!Array.isArray(context)) {
    throw new ClaudeProviderError(
      'CLAUDE_INVALID_OPTIONS',
      'Claude provider requires context to be an array when provided.',
      { context },
    );
  }

  return context.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeSystemPrompt(systemPrompt: ProviderRunOptions['systemPrompt']): string | undefined {
  if (systemPrompt === undefined) {
    return undefined;
  }

  if (typeof systemPrompt !== 'string') {
    throw new ClaudeProviderError(
      'CLAUDE_INVALID_OPTIONS',
      'Claude provider requires systemPrompt to be a string when provided.',
      { systemPrompt },
    );
  }

  const normalizedSystemPrompt = systemPrompt.trim();
  return normalizedSystemPrompt.length > 0 ? normalizedSystemPrompt : undefined;
}

function buildBridgedPrompt(prompt: string, systemPrompt: string | undefined, context: readonly string[]): string {
  if (!systemPrompt && context.length === 0) {
    return prompt;
  }

  const sections: string[] = [];
  if (systemPrompt) {
    sections.push(`System prompt:\n${systemPrompt}`);
  }
  if (context.length > 0) {
    const contextLines = context.map((entry, index) => `[${index + 1}] ${entry}`).join('\n');
    sections.push(`Context:\n${contextLines}`);
  }
  sections.push(`User prompt:\n${prompt}`);

  return sections.join('\n\n');
}

function createRunRequest(prompt: string, options: ProviderRunOptions): ClaudeRunRequest {
  if (options === null || options === undefined || typeof options !== 'object' || Array.isArray(options)) {
    throw new ClaudeProviderError('CLAUDE_INVALID_OPTIONS', 'Claude provider requires options to be an object.');
  }

  const validatedOptions = options as ProviderRunOptions & { workingDirectory?: unknown };
  const workingDirectory = validatedOptions.workingDirectory;
  if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
    throw new ClaudeProviderError(
      'CLAUDE_INVALID_OPTIONS',
      'Claude provider requires a non-empty workingDirectory option.',
    );
  }

  if (
    validatedOptions.maxTokens !== undefined
    && (!Number.isInteger(validatedOptions.maxTokens) || validatedOptions.maxTokens <= 0)
  ) {
    throw new ClaudeProviderError(
      'CLAUDE_INVALID_OPTIONS',
      'Claude provider requires maxTokens to be a positive integer.',
      {
        maxTokens: validatedOptions.maxTokens,
      },
    );
  }

  if (validatedOptions.timeout !== undefined && (!Number.isFinite(validatedOptions.timeout) || validatedOptions.timeout <= 0)) {
    throw new ClaudeProviderError('CLAUDE_INVALID_OPTIONS', 'Claude provider requires timeout to be a positive number.', {
      timeout: validatedOptions.timeout,
    });
  }

  const systemPrompt = normalizeSystemPrompt(validatedOptions.systemPrompt);
  const context = normalizeContext(validatedOptions.context);

  return {
    prompt,
    bridgedPrompt: buildBridgedPrompt(prompt, systemPrompt, context),
    workingDirectory,
    context,
    systemPrompt,
    maxTokens: validatedOptions.maxTokens,
    timeout: validatedOptions.timeout,
  };
}

async function* runClaudeAdapterV1(request: ClaudeRunRequest): AsyncIterable<ClaudeRawEvent> {
  yield {
    type: 'assistant',
    content: '',
    metadata: {
      adapter: 'claude-v1',
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

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const;
  readonly #runner: ClaudeRunner;

  constructor(runner: ClaudeRunner = runClaudeAdapterV1) {
    this.#runner = runner;
  }

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    const request = createRunRequest(prompt, options);

    yield createProviderEvent('system', 'Claude provider run started.', {
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
          throw new ClaudeProviderError(
            'CLAUDE_INVALID_EVENT',
            'Claude emitted events after a result event, which violates provider ordering.',
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
      if (error instanceof ClaudeProviderError) {
        throw error;
      }

      throw new ClaudeProviderError(
        'CLAUDE_RUN_FAILED',
        'Claude provider run failed.',
        {
          workingDirectory: request.workingDirectory,
          eventIndex,
        },
        error,
      );
    }

    if (!resultSeen) {
      throw new ClaudeProviderError(
        'CLAUDE_MISSING_RESULT',
        'Claude provider completed without emitting a result event.',
        { eventCount: eventIndex },
      );
    }
  }
}
