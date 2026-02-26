import { and, desc, eq } from 'drizzle-orm';
import { runNodeDiagnostics, runNodeStreamEvents, type AlphredDatabase } from '@alphred/db';
import type { ProviderEvent } from '@alphred/shared';
import {
  buildDiagnosticsPayload,
  extractTokenUsageFromEvent,
  sanitizeDiagnosticMetadata,
  sanitizeDiagnosticsString,
} from './diagnostics-collection.js';
import { MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS } from './constants.js';
import { truncateHeadTail } from './type-conversions.js';
import type { ContextHandoffManifest, RouteDecisionSignal, RunNodeExecutionRow, StreamUsageState } from './types.js';

export function resolveNextRunNodeStreamSequence(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
  },
): number {
  const latestEvent = db
    .select({
      sequence: runNodeStreamEvents.sequence,
    })
    .from(runNodeStreamEvents)
    .where(
      and(
        eq(runNodeStreamEvents.workflowRunId, params.workflowRunId),
        eq(runNodeStreamEvents.runNodeId, params.runNodeId),
        eq(runNodeStreamEvents.attempt, params.attempt),
      ),
    )
    .orderBy(desc(runNodeStreamEvents.sequence), desc(runNodeStreamEvents.id))
    .limit(1)
    .get();

  return (latestEvent?.sequence ?? 0) + 1;
}

export function persistRunNodeStreamEvent(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    sequence: number;
    event: ProviderEvent;
    usageState: StreamUsageState;
  },
): void {
  const state = {
    redacted: false,
    truncated: false,
  };
  const normalizedContent = sanitizeDiagnosticsString(params.event.content, state);
  const contentPreview = truncateHeadTail(normalizedContent, MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS);
  if (contentPreview.length < normalizedContent.length) {
    state.truncated = true;
  }

  const metadata = sanitizeDiagnosticMetadata(params.event.metadata, state);
  let usageDeltaTokens: number | null = null;
  let usageCumulativeTokens: number | null = null;
  const tokenUsage = extractTokenUsageFromEvent(params.event);
  if (tokenUsage) {
    if (tokenUsage.mode === 'incremental') {
      usageDeltaTokens = tokenUsage.tokens;
      usageCumulativeTokens = (params.usageState.cumulativeTokens ?? 0) + tokenUsage.tokens;
      params.usageState.cumulativeTokens = usageCumulativeTokens;
    } else {
      usageDeltaTokens =
        params.usageState.cumulativeTokens === null
          ? null
          : Math.max(tokenUsage.tokens - params.usageState.cumulativeTokens, 0);
      usageCumulativeTokens = tokenUsage.tokens;
      params.usageState.cumulativeTokens = tokenUsage.tokens;
    }
  }

  db.insert(runNodeStreamEvents)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      attempt: params.attempt,
      sequence: params.sequence,
      eventType: params.event.type,
      timestamp: params.event.timestamp,
      contentChars: params.event.content.length,
      contentPreview,
      metadata,
      usageDeltaTokens,
      usageCumulativeTokens,
    })
    .run();
}


export function persistRunNodeAttemptDiagnostics(
  db: AlphredDatabase,
  params: {
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
    error: unknown;
  },
): void {
  const diagnostics = buildDiagnosticsPayload(params);

  db.insert(runNodeDiagnostics)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.node.runNodeId,
      attempt: params.attempt,
      outcome: params.outcome,
      eventCount: diagnostics.eventCount,
      retainedEventCount: diagnostics.retainedEventCount,
      droppedEventCount: diagnostics.droppedEventCount,
      redacted: diagnostics.redacted ? 1 : 0,
      truncated: diagnostics.truncated ? 1 : 0,
      payloadChars: diagnostics.payloadChars,
      diagnostics: diagnostics.payload,
    })
    .onConflictDoNothing({
      target: [runNodeDiagnostics.workflowRunId, runNodeDiagnostics.runNodeId, runNodeDiagnostics.attempt],
    })
    .run();
}
