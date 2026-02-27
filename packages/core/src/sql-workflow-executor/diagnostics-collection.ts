import { compareStringsByCodeUnit, type ProviderEvent, type ProviderEventType } from '@alphred/shared';
import { PhaseRunError } from '../phaseRunner.js';
import {
  MAX_DIAGNOSTIC_ERROR_STACK_CHARS,
  MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_METADATA_CHARS,
  MAX_DIAGNOSTIC_PAYLOAD_CHARS,
  MAX_REDACTION_ARRAY_LENGTH,
  MAX_REDACTION_DEPTH,
  RUN_NODE_DIAGNOSTICS_SCHEMA_VERSION,
  sensitiveMetadataKeyPattern,
  sensitiveStringPattern,
} from './constants.js';
import { isRecord, truncateHeadTail } from './type-conversions.js';
import type {
  ContextHandoffManifest,
  DiagnosticErrorDetails,
  DiagnosticEvent,
  DiagnosticToolEvent,
  DiagnosticUsageSnapshot,
  RouteDecisionSignal,
  RunNodeErrorHandlerDiagnostics,
  RunNodeFailureRouteDiagnostics,
  RunNodeDiagnosticsPayload,
  RunNodeExecutionRow,
} from './types.js';

type TokenUsage =
  | {
      mode: 'incremental';
      tokens: number;
    }
  | {
      mode: 'cumulative';
      tokens: number;
    };

type DiagnosticsRedactionState = {
  redacted: boolean;
  truncated: boolean;
};

export function toNonNegativeTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

export function readCumulativeUsage(metadata: Record<string, unknown>): number | undefined {
  const candidates: number[] = [];

  const tokensUsed = toNonNegativeTokenCount(metadata.tokensUsed);
  if (tokensUsed !== undefined) {
    candidates.push(tokensUsed);
  }

  const totalTokens = toNonNegativeTokenCount(metadata.totalTokens);
  if (totalTokens !== undefined) {
    candidates.push(totalTokens);
  }

  const inputTokens = toNonNegativeTokenCount(metadata.inputTokens);
  const outputTokens = toNonNegativeTokenCount(metadata.outputTokens);
  if (inputTokens !== undefined && outputTokens !== undefined) {
    candidates.push(inputTokens + outputTokens);
  }

  const snakeCaseInputTokens = toNonNegativeTokenCount(metadata.input_tokens);
  const snakeCaseOutputTokens = toNonNegativeTokenCount(metadata.output_tokens);
  if (snakeCaseInputTokens !== undefined && snakeCaseOutputTokens !== undefined) {
    candidates.push(snakeCaseInputTokens + snakeCaseOutputTokens);
  }

  const snakeCaseTotalTokens = toNonNegativeTokenCount(metadata.total_tokens);
  if (snakeCaseTotalTokens !== undefined) {
    candidates.push(snakeCaseTotalTokens);
  }

  if (candidates.length === 0) {
    return undefined;
  }

  return Math.max(...candidates);
}

export function readTokenUsageFromMetadata(metadata: Record<string, unknown>): TokenUsage | undefined {
  const cumulativeTokens = readCumulativeUsage(metadata);
  if (cumulativeTokens !== undefined) {
    return {
      mode: 'cumulative',
      tokens: cumulativeTokens,
    };
  }

  const directTokens = toNonNegativeTokenCount(metadata.tokens);
  if (directTokens !== undefined) {
    return {
      mode: 'incremental',
      tokens: directTokens,
    };
  }

  return undefined;
}

export function extractTokenUsageFromEvent(event: ProviderEvent): TokenUsage | undefined {
  if (event.type !== 'usage' || !event.metadata) {
    return undefined;
  }

  const topLevelUsage = readTokenUsageFromMetadata(event.metadata);
  const nestedUsage = event.metadata.usage;
  const nestedMetadata = isRecord(nestedUsage) ? nestedUsage : undefined;
  const nestedTokenUsage = nestedMetadata ? readTokenUsageFromMetadata(nestedMetadata) : undefined;

  const cumulativeCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'cumulative' } => usage?.mode === 'cumulative')
    .map(usage => usage.tokens);
  if (cumulativeCandidates.length > 0) {
    return {
      mode: 'cumulative',
      tokens: Math.max(...cumulativeCandidates),
    };
  }

  const incrementalCandidates = [topLevelUsage, nestedTokenUsage]
    .filter((usage): usage is TokenUsage & { mode: 'incremental' } => usage?.mode === 'incremental')
    .map(usage => usage.tokens);
  if (incrementalCandidates.length > 0) {
    return {
      mode: 'incremental',
      tokens: Math.max(...incrementalCandidates),
    };
  }

  return undefined;
}

export function sanitizeDiagnosticsString(value: string, state: DiagnosticsRedactionState): string {
  if (sensitiveStringPattern.test(value)) {
    state.redacted = true;
    return '[REDACTED]';
  }

  return value;
}

export function stringifyRedactedFallback(value: unknown): string {
  switch (typeof value) {
    case 'function':
      return `[Function: ${value.name || 'anonymous'}]`;
    case 'symbol':
      return value.description ? `Symbol(${value.description})` : 'Symbol()';
    case 'bigint':
      return `${value.toString()}n`;
    case 'undefined':
      return 'undefined';
    default:
      return JSON.stringify(value);
  }
}

export function redactDiagnosticsValue(
  value: unknown,
  state: DiagnosticsRedactionState,
  depth = 0,
): unknown {
  if (depth >= MAX_REDACTION_DEPTH) {
    state.truncated = true;
    return '[MAX_DEPTH_REACHED]';
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeDiagnosticsString(value, state);
  }

  if (Array.isArray(value)) {
    const input = value as unknown[];
    if (input.length > MAX_REDACTION_ARRAY_LENGTH) {
      state.truncated = true;
    }
    return input.slice(0, MAX_REDACTION_ARRAY_LENGTH).map(item => redactDiagnosticsValue(item, state, depth + 1));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => compareStringsByCodeUnit(left, right));
    for (const [key, entryValue] of entries) {
      if (sensitiveMetadataKeyPattern.test(key)) {
        state.redacted = true;
        output[key] = '[REDACTED]';
        continue;
      }

      output[key] = redactDiagnosticsValue(entryValue, state, depth + 1);
    }
    return output;
  }

  return stringifyRedactedFallback(value);
}

export function sanitizeDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined,
  state: DiagnosticsRedactionState,
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  const redactedMetadata = redactDiagnosticsValue(metadata, state);
  const normalizedMetadata = isRecord(redactedMetadata)
    ? redactedMetadata
    : { value: redactedMetadata };
  const serialized = JSON.stringify(normalizedMetadata);
  if (serialized.length <= MAX_DIAGNOSTIC_METADATA_CHARS) {
    return normalizedMetadata;
  }

  state.truncated = true;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: truncateHeadTail(serialized, MAX_DIAGNOSTIC_METADATA_CHARS),
  };
}

export function extractToolName(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) {
    return null;
  }

  const candidates = [metadata.toolName, metadata.tool_name, metadata.tool, metadata.name, metadata.command];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

export function summarizeToolEventContent(
  event: DiagnosticEvent,
  toolName: string | null,
): string {
  const preview = event.contentPreview.trim();
  if (preview.length > 0) {
    return preview;
  }

  if (toolName) {
    return `${event.type} event for ${toolName}`;
  }

  return `${event.type} event`;
}

export function classifyDiagnosticError(error: unknown): DiagnosticErrorDetails['classification'] {
  const normalizedError = unwrapDiagnosticError(error);
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes('without a result event')) {
    return 'provider_result_missing';
  }

  if (message.includes('timeout')) {
    return 'timeout';
  }

  if (
    (normalizedError instanceof Error && normalizedError.name.toLowerCase().includes('abort')) ||
    message.includes('aborted')
  ) {
    return 'aborted';
  }

  return 'unknown';
}

export function toDiagnosticErrorDetails(error: unknown, state: DiagnosticsRedactionState): DiagnosticErrorDetails {
  const normalizedError = unwrapDiagnosticError(error);
  const name = normalizedError instanceof Error ? sanitizeDiagnosticsString(normalizedError.name, state) : 'Error';
  const message = sanitizeDiagnosticsString(toErrorMessage(error), state);
  const stackPreview =
    normalizedError instanceof Error && typeof normalizedError.stack === 'string'
      ? truncateHeadTail(sanitizeDiagnosticsString(normalizedError.stack, state), MAX_DIAGNOSTIC_ERROR_STACK_CHARS)
      : null;
  if (stackPreview !== null && stackPreview.length >= MAX_DIAGNOSTIC_ERROR_STACK_CHARS) {
    state.truncated = true;
  }

  return {
    name,
    message,
    classification: classifyDiagnosticError(error),
    stackPreview,
  };
}

function sanitizeAndTruncateDiagnosticsString(
  value: string | null,
  state: DiagnosticsRedactionState,
): string | null {
  if (value === null) {
    return null;
  }

  const sanitized = sanitizeDiagnosticsString(value, state);
  const truncated = truncateHeadTail(sanitized, MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS);
  if (truncated.length < sanitized.length) {
    state.truncated = true;
  }

  return truncated;
}

function sanitizeErrorHandlerDiagnostics(
  errorHandler: RunNodeErrorHandlerDiagnostics,
  state: DiagnosticsRedactionState,
): RunNodeErrorHandlerDiagnostics {
  return {
    ...errorHandler,
    provider: sanitizeAndTruncateDiagnosticsString(errorHandler.provider, state),
    model: sanitizeAndTruncateDiagnosticsString(errorHandler.model, state),
    errorMessage: sanitizeAndTruncateDiagnosticsString(errorHandler.errorMessage, state),
  };
}

export function buildDiagnosticEvents(
  events: ProviderEvent[],
  state: DiagnosticsRedactionState,
): {
  eventCount: number;
  retainedEvents: DiagnosticEvent[];
  droppedEventCount: number;
  eventTypeCounts: Partial<Record<ProviderEventType, number>>;
} {
  const eventTypeCounts: Partial<Record<ProviderEventType, number>> = {};
  const diagnosticEvents: DiagnosticEvent[] = [];
  let cumulativeTokens: number | null = null;

  for (const [eventIndex, event] of events.entries()) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;

    const normalizedContent = sanitizeDiagnosticsString(event.content, state);
    const contentPreview = truncateHeadTail(normalizedContent, MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS);
    if (contentPreview.length < normalizedContent.length) {
      state.truncated = true;
    }

    const metadata = sanitizeDiagnosticMetadata(event.metadata, state);
    const tokenUsage = extractTokenUsageFromEvent(event);
    let usage: DiagnosticUsageSnapshot | null = null;
    if (tokenUsage) {
      if (tokenUsage.mode === 'incremental') {
        const nextCumulativeTokens: number = (cumulativeTokens ?? 0) + tokenUsage.tokens;
        cumulativeTokens = nextCumulativeTokens;
        usage = {
          deltaTokens: tokenUsage.tokens,
          cumulativeTokens: nextCumulativeTokens,
        };
      } else {
        const previous = cumulativeTokens;
        cumulativeTokens = tokenUsage.tokens;
        usage = {
          deltaTokens: previous === null ? null : Math.max(tokenUsage.tokens - previous, 0),
          cumulativeTokens: tokenUsage.tokens,
        };
      }
    }

    diagnosticEvents.push({
      eventIndex,
      type: event.type,
      timestamp: event.timestamp,
      contentChars: event.content.length,
      contentPreview,
      metadata,
      usage,
    });
  }

  const retainedEvents = diagnosticEvents.slice(0, MAX_DIAGNOSTIC_EVENTS);
  const droppedEventCount = Math.max(diagnosticEvents.length - retainedEvents.length, 0);
  if (droppedEventCount > 0) {
    state.truncated = true;
  }

  return {
    eventCount: diagnosticEvents.length,
    retainedEvents,
    droppedEventCount,
    eventTypeCounts,
  };
}


export function buildToolEventSummaries(events: DiagnosticEvent[]): DiagnosticToolEvent[] {
  const summaries: DiagnosticToolEvent[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use' && event.type !== 'tool_result') {
      continue;
    }

    const toolName = extractToolName(event.metadata);
    summaries.push({
      eventIndex: event.eventIndex,
      type: event.type,
      timestamp: event.timestamp,
      toolName,
      summary: summarizeToolEventContent(event, toolName),
    });
  }

  return summaries;
}

export function buildDiagnosticsPayload(params: {
  workflowRunId: number;
  node: RunNodeExecutionRow;
  attempt: number;
  outcome: 'completed' | 'failed';
  status: 'completed' | 'failed';
  runNodeSnapshot: RunNodeExecutionRow;
  contextManifest: ContextHandoffManifest;
  tokensUsed: number;
  events: ProviderEvent[];
  routingDecision: RouteDecisionSignal | null;
  failureRoute?: RunNodeFailureRouteDiagnostics;
  error: unknown;
  errorHandler?: RunNodeErrorHandlerDiagnostics;
}): {
  payload: RunNodeDiagnosticsPayload;
  payloadChars: number;
  redacted: boolean;
  truncated: boolean;
  eventCount: number;
  retainedEventCount: number;
  droppedEventCount: number;
} {
  const redactionState: DiagnosticsRedactionState = {
    redacted: false,
    truncated: false,
  };
  const persistedAt = new Date().toISOString();
  const eventBuild = buildDiagnosticEvents(params.events, redactionState);
  let retainedEvents = eventBuild.retainedEvents;
  let droppedEventCount = eventBuild.droppedEventCount;
  let toolEvents = buildToolEventSummaries(retainedEvents);
  let errorDetails = params.error === null ? null : toDiagnosticErrorDetails(params.error, redactionState);
  const sanitizedErrorHandler =
    params.errorHandler === undefined ? undefined : sanitizeErrorHandlerDiagnostics(params.errorHandler, redactionState);

  const buildPayload = (): RunNodeDiagnosticsPayload => ({
    schemaVersion: RUN_NODE_DIAGNOSTICS_SCHEMA_VERSION,
    workflowRunId: params.workflowRunId,
    runNodeId: params.node.runNodeId,
    nodeKey: params.node.nodeKey,
    attempt: params.attempt,
    outcome: params.outcome,
    status: params.status,
    provider: params.node.provider,
    timing: {
      queuedAt: params.node.createdAt ?? null,
      startedAt: params.runNodeSnapshot.startedAt,
      completedAt: params.status === 'completed' ? params.runNodeSnapshot.completedAt : null,
      failedAt: params.status === 'failed' ? params.runNodeSnapshot.completedAt : null,
      persistedAt,
    },
    summary: {
      tokensUsed: params.tokensUsed,
      eventCount: eventBuild.eventCount,
      retainedEventCount: retainedEvents.length,
      droppedEventCount,
      toolEventCount: toolEvents.length,
      redacted: redactionState.redacted,
      truncated: redactionState.truncated,
    },
    contextHandoff: params.contextManifest,
    eventTypeCounts: eventBuild.eventTypeCounts,
    events: retainedEvents,
    toolEvents,
    routingDecision: params.routingDecision,
    ...(params.failureRoute === undefined ? {} : { failureRoute: params.failureRoute }),
    error: errorDetails,
    ...(sanitizedErrorHandler === undefined ? {} : { errorHandler: sanitizedErrorHandler }),
  });

  let payload = buildPayload();
  let payloadChars = JSON.stringify(payload).length;
  while (payloadChars > MAX_DIAGNOSTIC_PAYLOAD_CHARS && retainedEvents.length > 0) {
    retainedEvents = retainedEvents.slice(0, -1);
    droppedEventCount += 1;
    toolEvents = buildToolEventSummaries(retainedEvents);
    redactionState.truncated = true;
    payload = buildPayload();
    payloadChars = JSON.stringify(payload).length;
  }

  if (payloadChars > MAX_DIAGNOSTIC_PAYLOAD_CHARS && errorDetails?.stackPreview) {
    errorDetails = {
      ...errorDetails,
      stackPreview: null,
    };
    redactionState.truncated = true;
    payload = buildPayload();
    payloadChars = JSON.stringify(payload).length;
  }

  payload.summary.redacted = redactionState.redacted;
  payload.summary.truncated = redactionState.truncated;
  payload.summary.retainedEventCount = retainedEvents.length;
  payload.summary.droppedEventCount = droppedEventCount;
  payload.summary.toolEventCount = toolEvents.length;
  payload.error = errorDetails;
  payloadChars = JSON.stringify(payload).length;

  return {
    payload,
    payloadChars,
    redacted: redactionState.redacted,
    truncated: redactionState.truncated,
    eventCount: eventBuild.eventCount,
    retainedEventCount: retainedEvents.length,
    droppedEventCount,
  };
}


export function unwrapDiagnosticError(error: unknown): unknown {
  if (error instanceof PhaseRunError && error.cause !== undefined) {
    return error.cause;
  }

  return error;
}

export function toErrorMessage(error: unknown): string {
  const candidate = unwrapDiagnosticError(error);
  if (candidate instanceof Error) {
    return candidate.message;
  }

  return String(candidate);
}
