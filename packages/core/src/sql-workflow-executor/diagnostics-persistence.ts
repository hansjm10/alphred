import { and, desc, eq } from 'drizzle-orm';
import { phaseArtifacts, runNodeDiagnostics, runNodeStreamEvents, type AlphredDatabase } from '@alphred/db';
import type { ProviderEvent } from '@alphred/shared';
import {
  buildDiagnosticsPayload,
  extractTokenUsageFromEvent,
  sanitizeDiagnosticMetadata,
  sanitizeDiagnosticsString,
} from './diagnostics-collection.js';
import {
  FAILED_COMMAND_OUTPUT_ARTIFACT_KIND,
  FAILED_COMMAND_OUTPUT_SCHEMA_VERSION,
  MAX_DIAGNOSTIC_EVENT_CONTENT_CHARS,
} from './constants.js';
import { truncateHeadTail } from './type-conversions.js';
import type {
  ContextHandoffManifest,
  DiagnosticCommandOutputReference,
  RouteDecisionSignal,
  RunNodeErrorHandlerDiagnostics,
  RunNodeFailureRouteDiagnostics,
  RunNodeExecutionRow,
  StreamUsageState,
} from './types.js';

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

type FailedCommandOutput = {
  command: string | null;
  exitCode: number;
  output: string;
  outputChars: number;
  stdout: string | null;
  stderr: string | null;
  redacted: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveFailedCommandOutput(event: ProviderEvent): FailedCommandOutput | null {
  if (event.type !== 'tool_result') {
    return null;
  }

  const contentRecord = parseJsonRecord(event.content);
  const metadataRecord = isRecord(event.metadata) ? event.metadata : null;
  const metadataItem = metadataRecord && isRecord(metadataRecord.item) ? metadataRecord.item : null;

  const command =
    toOptionalString(contentRecord?.command)
    ?? toOptionalString(metadataItem?.command)
    ?? toOptionalString(metadataRecord?.command)
    ?? null;
  const itemType =
    toOptionalString(metadataRecord?.itemType)
    ?? toOptionalString(metadataItem?.type)
    ?? null;
  const exitCode =
    toOptionalNumber(contentRecord?.exit_code)
    ?? toOptionalNumber(contentRecord?.exitCode)
    ?? toOptionalNumber(metadataItem?.exit_code)
    ?? toOptionalNumber(metadataItem?.exitCode)
    ?? toOptionalNumber(metadataRecord?.exit_code)
    ?? toOptionalNumber(metadataRecord?.exitCode);

  const looksLikeCommandEvent = itemType === 'command_execution' || command !== null;
  if (!looksLikeCommandEvent || exitCode === null || exitCode === 0) {
    return null;
  }

  const redactionState = {
    redacted: false,
    truncated: false,
  };
  const stdout = sanitizeDiagnosticsString(
    toOptionalString(contentRecord?.stdout) ?? toOptionalString(metadataItem?.stdout) ?? '',
    redactionState,
  );
  const stderr = sanitizeDiagnosticsString(
    toOptionalString(contentRecord?.stderr) ?? toOptionalString(metadataItem?.stderr) ?? '',
    redactionState,
  );
  const aggregatedOutput =
    toOptionalString(contentRecord?.output)
    ?? toOptionalString(contentRecord?.aggregated_output)
    ?? toOptionalString(contentRecord?.aggregatedOutput)
    ?? toOptionalString(metadataItem?.aggregated_output)
    ?? toOptionalString(metadataItem?.aggregatedOutput);
  const combinedOutput = [stdout, stderr].filter(part => part.length > 0).join('\n');
  const selectedOutput = combinedOutput.length > 0 ? combinedOutput : (aggregatedOutput ?? '');
  const output = sanitizeDiagnosticsString(selectedOutput.length > 0 ? selectedOutput : event.content, redactionState);
  const sanitizedCommand = command === null ? null : sanitizeDiagnosticsString(command, redactionState);

  return {
    command: sanitizedCommand,
    exitCode,
    output,
    outputChars: output.length,
    stdout: stdout.length > 0 ? stdout : null,
    stderr: stderr.length > 0 ? stderr : null,
    redacted: redactionState.redacted,
  };
}

function buildFailedCommandOutputPath(
  workflowRunId: number,
  runNodeId: number,
  attempt: number,
  eventIndex: number,
): string {
  return `/api/dashboard/runs/${workflowRunId}/nodes/${runNodeId}/diagnostics/${attempt}/commands/${eventIndex}`;
}

function persistFailedCommandOutputs(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    events: ProviderEvent[];
  },
): DiagnosticCommandOutputReference[] {
  const references: DiagnosticCommandOutputReference[] = [];
  for (const [eventIndex, event] of params.events.entries()) {
    const failedCommandOutput = resolveFailedCommandOutput(event);
    if (!failedCommandOutput) {
      continue;
    }

    const sequence = eventIndex + 1;
    const path = buildFailedCommandOutputPath(
      params.workflowRunId,
      params.runNodeId,
      params.attempt,
      eventIndex,
    );
    const artifact = db
      .insert(phaseArtifacts)
      .values({
        workflowRunId: params.workflowRunId,
        runNodeId: params.runNodeId,
        artifactType: 'log',
        contentType: 'json',
        content: JSON.stringify({
          schemaVersion: FAILED_COMMAND_OUTPUT_SCHEMA_VERSION,
          workflowRunId: params.workflowRunId,
          runNodeId: params.runNodeId,
          attempt: params.attempt,
          eventIndex,
          sequence,
          command: failedCommandOutput.command,
          exitCode: failedCommandOutput.exitCode,
          output: failedCommandOutput.output,
          outputChars: failedCommandOutput.outputChars,
          stdout: failedCommandOutput.stdout,
          stderr: failedCommandOutput.stderr,
        }),
        metadata: {
          kind: FAILED_COMMAND_OUTPUT_ARTIFACT_KIND,
          attempt: params.attempt,
          eventIndex,
          sequence,
          command: failedCommandOutput.command,
          exitCode: failedCommandOutput.exitCode,
          outputChars: failedCommandOutput.outputChars,
          redacted: failedCommandOutput.redacted,
        },
      })
      .returning({ id: phaseArtifacts.id })
      .get();

    references.push({
      eventIndex,
      sequence,
      artifactId: artifact.id,
      command: failedCommandOutput.command,
      exitCode: failedCommandOutput.exitCode,
      outputChars: failedCommandOutput.outputChars,
      path,
    });
  }

  return references;
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
    failureRoute?: RunNodeFailureRouteDiagnostics;
    error: unknown;
    errorHandler?: RunNodeErrorHandlerDiagnostics;
  },
): void {
  const existingSnapshot = db
    .select({
      id: runNodeDiagnostics.id,
    })
    .from(runNodeDiagnostics)
    .where(
      and(
        eq(runNodeDiagnostics.workflowRunId, params.workflowRunId),
        eq(runNodeDiagnostics.runNodeId, params.node.runNodeId),
        eq(runNodeDiagnostics.attempt, params.attempt),
      ),
    )
    .limit(1)
    .get();
  if (existingSnapshot) {
    return;
  }

  const failedCommandOutputs = persistFailedCommandOutputs(db, {
    workflowRunId: params.workflowRunId,
    runNodeId: params.node.runNodeId,
    attempt: params.attempt,
    events: params.events,
  });
  const diagnostics = buildDiagnosticsPayload({
    ...params,
    failedCommandOutputs,
  });

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
