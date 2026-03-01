import { describe, expect, it } from 'vitest';
import type { ProviderEvent } from '@alphred/shared';
import { MAX_DIAGNOSTIC_PAYLOAD_CHARS } from './constants.js';
import { buildDiagnosticsPayload } from './diagnostics-collection.js';
import type {
  ContextHandoffManifest,
  DiagnosticCommandOutputReference,
  RunNodeExecutionRow,
} from './types.js';

type BuildDiagnosticsPayloadParams = Parameters<typeof buildDiagnosticsPayload>[0];

function createRunNodeExecutionRow(overrides: Partial<RunNodeExecutionRow> = {}): RunNodeExecutionRow {
  return {
    runNodeId: 11,
    treeNodeId: 5,
    nodeKey: 'analysis',
    nodeRole: 'worker',
    status: 'failed',
    sequenceIndex: 1,
    sequencePath: '1',
    lineageDepth: 0,
    spawnerNodeId: null,
    joinNodeId: null,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    maxChildren: 0,
    maxRetries: 0,
    nodeType: 'agent',
    provider: 'codex',
    model: 'gpt-5-codex-mini',
    executionPermissions: null,
    errorHandlerConfig: null,
    prompt: 'Inspect the failure',
    promptContentType: 'markdown',
    ...overrides,
  };
}

function createContextHandoffManifest(overrides: Partial<ContextHandoffManifest> = {}): ContextHandoffManifest {
  return {
    context_policy_version: 1,
    included_artifact_ids: [],
    included_source_node_keys: [],
    included_source_run_node_ids: [],
    included_count: 0,
    included_chars_total: 0,
    truncated_artifact_ids: [],
    missing_upstream_artifacts: false,
    assembly_timestamp: '2026-01-01T00:00:00.000Z',
    no_eligible_artifact_types: false,
    budget_overflow: false,
    dropped_artifact_ids: [],
    failure_route_context_included: false,
    failure_route_source_node_key: null,
    failure_route_source_run_node_id: null,
    failure_route_failure_artifact_id: null,
    failure_route_retry_summary_artifact_id: null,
    failure_route_context_chars: 0,
    failure_route_context_truncated: false,
    retry_summary_included: false,
    retry_summary_artifact_id: null,
    retry_summary_source_attempt: null,
    retry_summary_target_attempt: null,
    retry_summary_chars: 0,
    retry_summary_truncated: false,
    ...overrides,
  };
}

function createDiagnosticsPayloadParams(
  overrides: Partial<BuildDiagnosticsPayloadParams> = {},
): BuildDiagnosticsPayloadParams {
  const node = createRunNodeExecutionRow();
  return {
    workflowRunId: 99,
    node,
    attempt: 1,
    outcome: 'failed',
    status: 'failed',
    runNodeSnapshot: node,
    contextManifest: createContextHandoffManifest(),
    tokensUsed: 0,
    events: [],
    routingDecision: null,
    error: new Error('execution failed'),
    ...overrides,
  };
}

function createFailedCommandOutputReference(
  eventIndex: number,
  pathSegmentLength: number,
): DiagnosticCommandOutputReference {
  return {
    eventIndex,
    sequence: eventIndex + 1,
    artifactId: eventIndex + 1000,
    command: `cmd-${eventIndex.toString().padStart(4, '0')}-${'x'.repeat(140)}`,
    exitCode: 1,
    outputChars: 120_000,
    path: `/api/dashboard/runs/99/nodes/11/diagnostics/1/commands/${eventIndex}-${'y'.repeat(pathSegmentLength)}`,
  };
}

function createProviderEvent(eventIndex: number, contentLength: number): ProviderEvent {
  return {
    type: 'assistant',
    content: `event-${eventIndex.toString().padStart(3, '0')}-${'z'.repeat(contentLength)}`,
    timestamp: eventIndex,
  };
}

describe('buildDiagnosticsPayload', () => {
  it('trims failed command output references to enforce payload size bounds', () => {
    const failedCommandOutputs = Array.from({ length: 220 }, (_unused, eventIndex) =>
      createFailedCommandOutputReference(eventIndex, 180),
    );

    const diagnostics = buildDiagnosticsPayload(
      createDiagnosticsPayloadParams({
        failedCommandOutputs,
      }),
    );

    const retainedFailedCommandOutputs = diagnostics.payload.failedCommandOutputs ?? [];
    expect(diagnostics.payloadChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_PAYLOAD_CHARS);
    expect(diagnostics.payload.summary.truncated).toBe(true);
    expect(retainedFailedCommandOutputs.length).toBeLessThan(failedCommandOutputs.length);
    if (retainedFailedCommandOutputs.length > 0) {
      expect(retainedFailedCommandOutputs[0]).toEqual(failedCommandOutputs[0]);
      expect(retainedFailedCommandOutputs.at(-1)?.eventIndex).toBe(retainedFailedCommandOutputs.length - 1);
    }
  });

  it('keeps failed command output references when payload stays within bounds', () => {
    const failedCommandOutputs = Array.from({ length: 2 }, (_unused, eventIndex) =>
      createFailedCommandOutputReference(eventIndex, 20),
    );

    const diagnostics = buildDiagnosticsPayload(
      createDiagnosticsPayloadParams({
        failedCommandOutputs,
      }),
    );

    expect(diagnostics.payloadChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_PAYLOAD_CHARS);
    expect(diagnostics.payload.failedCommandOutputs).toEqual(failedCommandOutputs);
  });

  it('trims failed command output references before dropping events', () => {
    const events = Array.from({ length: 40 }, (_unused, eventIndex) => createProviderEvent(eventIndex, 520));
    const failedCommandOutputs = Array.from({ length: 320 }, (_unused, eventIndex) =>
      createFailedCommandOutputReference(eventIndex, 180),
    );

    const diagnosticsWithoutFailedCommandOutputs = buildDiagnosticsPayload(
      createDiagnosticsPayloadParams({
        events,
      }),
    );
    expect(diagnosticsWithoutFailedCommandOutputs.payloadChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_PAYLOAD_CHARS);
    expect(diagnosticsWithoutFailedCommandOutputs.droppedEventCount).toBe(0);

    const diagnostics = buildDiagnosticsPayload(
      createDiagnosticsPayloadParams({
        events,
        failedCommandOutputs,
      }),
    );

    const retainedFailedCommandOutputs = diagnostics.payload.failedCommandOutputs ?? [];
    expect(diagnostics.payloadChars).toBeLessThanOrEqual(MAX_DIAGNOSTIC_PAYLOAD_CHARS);
    expect(diagnostics.payload.events).toHaveLength(events.length);
    expect(diagnostics.droppedEventCount).toBe(0);
    expect(diagnostics.payload.summary.droppedEventCount).toBe(0);
    expect(retainedFailedCommandOutputs.length).toBeLessThan(failedCommandOutputs.length);
  });
});
