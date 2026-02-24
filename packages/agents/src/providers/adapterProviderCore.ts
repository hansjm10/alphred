import { inspect } from 'node:util';
import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type ProviderEvent,
  type ProviderExecutionPermissions,
  type ProviderRunOptions,
} from '@alphred/shared';
import { createProviderEvent } from '../provider.js';

const defaultProviderEventTypeAliases: Readonly<Record<string, ProviderEvent['type']>> = Object.freeze({
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

const MAX_TIMEOUT_MS = 2_147_483_647;

export type AdapterRunRequest = Readonly<{
  prompt: string;
  bridgedPrompt: string;
  workingDirectory: string;
  context: readonly string[];
  systemPrompt?: string;
  model?: string;
  timeout?: number;
  executionPermissions?: ProviderExecutionPermissions;
}>;

export type AdapterRawEvent = Readonly<{
  type: string;
  content?: unknown;
  metadata?: unknown;
}>;

export type AdapterRunner = (request: AdapterRunRequest) => AsyncIterable<AdapterRawEvent>;

type AdapterProviderErrorFactory<Code extends string, TError extends Error> = (
  code: Code,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
) => TError;

type AdapterProviderErrorCodes<Code extends string> = Readonly<{
  invalidOptions: Code;
  invalidEvent: Code;
  missingResult: Code;
  runFailed: Code;
}>;

export type AdapterProviderConfig<Code extends string, TError extends Error> = Readonly<{
  providerName: string;
  providerDisplayName: string;
  adapterName: string;
  codes: AdapterProviderErrorCodes<Code>;
  createError: AdapterProviderErrorFactory<Code, TError>;
  isProviderError: (error: unknown) => error is TError;
  eventTypeAliases?: Readonly<Record<string, ProviderEvent['type']>>;
  supportsExecutionPermissions?: boolean;
}>;

const executionPermissionKeys = new Set([
  'approvalPolicy',
  'sandboxMode',
  'networkAccessEnabled',
  'additionalDirectories',
  'webSearchMode',
]);
const executionApprovalPolicies = new Set(providerApprovalPolicies);
const executionSandboxModes = new Set(providerSandboxModes);
const executionWebSearchModes = new Set(providerWebSearchModes);

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

function normalizeEventType(
  rawType: string,
  eventTypeAliases: Readonly<Record<string, ProviderEvent['type']>>,
): ProviderEvent['type'] | undefined {
  if (supportedProviderEventTypes.has(rawType as ProviderEvent['type'])) {
    return rawType as ProviderEvent['type'];
  }

  return eventTypeAliases[rawType];
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

function normalizeRawEvent<Code extends string, TError extends Error>(
  rawEvent: AdapterRawEvent,
  eventIndex: number,
  config: AdapterProviderConfig<Code, TError>,
  eventTypeAliases: Readonly<Record<string, ProviderEvent['type']>>,
): ProviderEvent {
  const normalizedType = normalizeEventType(rawEvent.type, eventTypeAliases);
  if (!normalizedType) {
    throw config.createError(
      config.codes.invalidEvent,
      `${config.providerDisplayName} emitted unsupported event type "${rawEvent.type}".`,
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

function normalizeContext<Code extends string, TError extends Error>(
  context: ProviderRunOptions['context'],
  config: AdapterProviderConfig<Code, TError>,
): string[] {
  if (context === undefined) {
    return [];
  }

  if (!Array.isArray(context)) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires context to be an array when provided.`,
      { context },
    );
  }

  return context.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeSystemPrompt<Code extends string, TError extends Error>(
  systemPrompt: ProviderRunOptions['systemPrompt'],
  config: AdapterProviderConfig<Code, TError>,
): string | undefined {
  if (systemPrompt === undefined) {
    return undefined;
  }

  if (typeof systemPrompt !== 'string') {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires systemPrompt to be a string when provided.`,
      { systemPrompt },
    );
  }

  const normalizedSystemPrompt = systemPrompt.trim();
  return normalizedSystemPrompt.length > 0 ? normalizedSystemPrompt : undefined;
}

function normalizeModel<Code extends string, TError extends Error>(
  model: ProviderRunOptions['model'],
  config: AdapterProviderConfig<Code, TError>,
): string | undefined {
  if (model === undefined) {
    return undefined;
  }

  if (typeof model !== 'string') {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires model to be a string when provided.`,
      { model },
    );
  }

  const normalizedModel = model.trim();
  if (normalizedModel.length === 0) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires model to be a non-empty string when provided.`,
      { model },
    );
  }

  return normalizedModel;
}

function createExecutionPermissionsValidationError<Code extends string, TError extends Error>(
  config: AdapterProviderConfig<Code, TError>,
  executionPermissions: unknown,
  message: string,
  details?: Record<string, unknown>,
): TError {
  return config.createError(
    config.codes.invalidOptions,
    message,
    details ? { executionPermissions, ...details } : { executionPermissions },
  );
}

function toRawExecutionPermissions<Code extends string, TError extends Error>(
  executionPermissions: ProviderRunOptions['executionPermissions'] | null,
  config: AdapterProviderConfig<Code, TError>,
): Record<string, unknown> {
  if (typeof executionPermissions !== 'object' || Array.isArray(executionPermissions)) {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions to be an object when provided.`,
    );
  }

  return executionPermissions as Record<string, unknown>;
}

function assertExecutionPermissionKeysAreSupported<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): void {
  for (const key of Object.keys(rawPermissions)) {
    if (executionPermissionKeys.has(key)) {
      continue;
    }

    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider does not recognize executionPermissions.${key}.`,
    );
  }
}

function parseExecutionPermissionApprovalPolicy<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): (typeof providerApprovalPolicies)[number] | undefined {
  const approvalPolicy = rawPermissions.approvalPolicy;
  if (approvalPolicy === undefined) {
    return undefined;
  }

  if (
    typeof approvalPolicy !== 'string'
    || !executionApprovalPolicies.has(approvalPolicy as (typeof providerApprovalPolicies)[number])
  ) {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions.approvalPolicy to be a supported value.`,
    );
  }

  return approvalPolicy as (typeof providerApprovalPolicies)[number];
}

function parseExecutionPermissionSandboxMode<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): (typeof providerSandboxModes)[number] | undefined {
  const sandboxMode = rawPermissions.sandboxMode;
  if (sandboxMode === undefined) {
    return undefined;
  }

  if (
    typeof sandboxMode !== 'string'
    || !executionSandboxModes.has(sandboxMode as (typeof providerSandboxModes)[number])
  ) {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions.sandboxMode to be a supported value.`,
    );
  }

  return sandboxMode as (typeof providerSandboxModes)[number];
}

function parseExecutionPermissionNetworkAccessEnabled<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): boolean | undefined {
  const networkAccessEnabled = rawPermissions.networkAccessEnabled;
  if (networkAccessEnabled === undefined) {
    return undefined;
  }

  if (typeof networkAccessEnabled !== 'boolean') {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions.networkAccessEnabled to be a boolean.`,
    );
  }

  return networkAccessEnabled;
}

function parseExecutionPermissionAdditionalDirectories<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): string[] | undefined {
  const additionalDirectories = rawPermissions.additionalDirectories;
  if (additionalDirectories === undefined) {
    return undefined;
  }

  if (!Array.isArray(additionalDirectories)) {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions.additionalDirectories to be an array when provided.`,
    );
  }

  return additionalDirectories.map((directory, index) => {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw createExecutionPermissionsValidationError(
        config,
        executionPermissions,
        `${config.providerDisplayName} provider requires executionPermissions.additionalDirectories entries to be non-empty strings.`,
        { index },
      );
    }

    return directory.trim();
  });
}

function parseExecutionPermissionWebSearchMode<Code extends string, TError extends Error>(
  rawPermissions: Record<string, unknown>,
  executionPermissions: unknown,
  config: AdapterProviderConfig<Code, TError>,
): (typeof providerWebSearchModes)[number] | undefined {
  const webSearchMode = rawPermissions.webSearchMode;
  if (webSearchMode === undefined) {
    return undefined;
  }

  if (
    typeof webSearchMode !== 'string'
    || !executionWebSearchModes.has(webSearchMode as (typeof providerWebSearchModes)[number])
  ) {
    throw createExecutionPermissionsValidationError(
      config,
      executionPermissions,
      `${config.providerDisplayName} provider requires executionPermissions.webSearchMode to be a supported value.`,
    );
  }

  return webSearchMode as (typeof providerWebSearchModes)[number];
}

function normalizeExecutionPermissions<Code extends string, TError extends Error>(
  executionPermissions: ProviderRunOptions['executionPermissions'] | null,
  config: AdapterProviderConfig<Code, TError>,
): ProviderExecutionPermissions | undefined {
  if (executionPermissions === undefined || executionPermissions === null) {
    return undefined;
  }

  const rawPermissions = toRawExecutionPermissions(executionPermissions, config);
  assertExecutionPermissionKeysAreSupported(rawPermissions, executionPermissions, config);

  const normalized: ProviderExecutionPermissions = {};
  const approvalPolicy = parseExecutionPermissionApprovalPolicy(rawPermissions, executionPermissions, config);
  if (approvalPolicy !== undefined) {
    normalized.approvalPolicy = approvalPolicy;
  }

  const sandboxMode = parseExecutionPermissionSandboxMode(rawPermissions, executionPermissions, config);
  if (sandboxMode !== undefined) {
    normalized.sandboxMode = sandboxMode;
  }

  const networkAccessEnabled = parseExecutionPermissionNetworkAccessEnabled(rawPermissions, executionPermissions, config);
  if (networkAccessEnabled !== undefined) {
    normalized.networkAccessEnabled = networkAccessEnabled;
  }

  const additionalDirectories = parseExecutionPermissionAdditionalDirectories(rawPermissions, executionPermissions, config);
  if (additionalDirectories !== undefined && additionalDirectories.length > 0) {
    normalized.additionalDirectories = additionalDirectories;
  }

  const webSearchMode = parseExecutionPermissionWebSearchMode(rawPermissions, executionPermissions, config);
  if (webSearchMode !== undefined) {
    normalized.webSearchMode = webSearchMode;
  }

  if (Object.keys(normalized).length === 0) {
    return undefined;
  }

  if (config.supportsExecutionPermissions !== true) {
    throw createExecutionPermissionsValidationError(
      config,
      normalized,
      `${config.providerDisplayName} provider does not support executionPermissions.`,
    );
  }

  return normalized;
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

function createRunRequest<Code extends string, TError extends Error>(
  prompt: string,
  options: ProviderRunOptions,
  config: AdapterProviderConfig<Code, TError>,
): AdapterRunRequest {
  if (options === null || options === undefined || typeof options !== 'object' || Array.isArray(options)) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires options to be an object.`,
    );
  }

  const validatedOptions = options as ProviderRunOptions & { workingDirectory?: unknown };
  const workingDirectory = validatedOptions.workingDirectory;
  if (typeof workingDirectory !== 'string' || workingDirectory.trim().length === 0) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires a non-empty workingDirectory option.`,
    );
  }

  if (validatedOptions.timeout !== undefined && (!Number.isFinite(validatedOptions.timeout) || validatedOptions.timeout <= 0)) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires timeout to be a positive number.`,
      { timeout: validatedOptions.timeout },
    );
  }

  if (validatedOptions.timeout !== undefined && validatedOptions.timeout > MAX_TIMEOUT_MS) {
    throw config.createError(
      config.codes.invalidOptions,
      `${config.providerDisplayName} provider requires timeout to be no greater than ${MAX_TIMEOUT_MS} milliseconds.`,
      { timeout: validatedOptions.timeout, maxTimeout: MAX_TIMEOUT_MS },
    );
  }

  const systemPrompt = normalizeSystemPrompt(validatedOptions.systemPrompt, config);
  const model = normalizeModel(validatedOptions.model, config);
  const context = normalizeContext(validatedOptions.context, config);
  const executionPermissions = normalizeExecutionPermissions(validatedOptions.executionPermissions ?? null, config);

  return {
    prompt,
    bridgedPrompt: buildBridgedPrompt(prompt, systemPrompt, context),
    workingDirectory,
    context,
    systemPrompt,
    model,
    timeout: validatedOptions.timeout,
    executionPermissions,
  };
}

export function createDefaultAdapterRunner(adapterName: string): AdapterRunner {
  return async function* runAdapterV1(request: AdapterRunRequest): AsyncIterable<AdapterRawEvent> {
    yield {
      type: 'assistant',
      content: '',
      metadata: {
        adapter: adapterName,
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
  };
}

export async function* runAdapterProvider<Code extends string, TError extends Error>(
  prompt: string,
  options: ProviderRunOptions,
  runner: AdapterRunner,
  config: AdapterProviderConfig<Code, TError>,
): AsyncIterable<ProviderEvent> {
  const request = createRunRequest(prompt, options, config);
  const eventTypeAliases = Object.freeze({
    ...defaultProviderEventTypeAliases,
    ...config.eventTypeAliases,
  });

  const runStartedMetadata: Record<string, unknown> = {
    provider: config.providerName,
    workingDirectory: request.workingDirectory,
    hasSystemPrompt: request.systemPrompt !== undefined,
    contextItemCount: request.context.length,
    timeout: request.timeout,
  };
  if (request.model !== undefined) {
    runStartedMetadata.model = request.model;
  }
  if (request.executionPermissions !== undefined) {
    runStartedMetadata.executionPermissions = request.executionPermissions;
  }

  yield createProviderEvent('system', `${config.providerDisplayName} provider run started.`, {
    ...runStartedMetadata,
  });

  let eventIndex = 0;
  let resultSeen = false;

  try {
    for await (const rawEvent of runner(request)) {
      eventIndex += 1;
      const event = normalizeRawEvent(rawEvent, eventIndex, config, eventTypeAliases);

      if (resultSeen) {
        throw config.createError(
          config.codes.invalidEvent,
          `${config.providerDisplayName} emitted events after a result event, which violates provider ordering.`,
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
    if (config.isProviderError(error)) {
      throw error;
    }

    throw config.createError(
      config.codes.runFailed,
      `${config.providerDisplayName} provider run failed.`,
      {
        workingDirectory: request.workingDirectory,
        eventIndex,
      },
      error,
    );
  }

  if (!resultSeen) {
    throw config.createError(
      config.codes.missingResult,
      `${config.providerDisplayName} provider completed without emitting a result event.`,
      { eventCount: eventIndex },
    );
  }
}
