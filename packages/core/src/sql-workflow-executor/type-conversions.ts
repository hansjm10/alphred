import { createHash } from 'node:crypto';
import type { RunNodeStatus, WorkflowRunStatus } from '@alphred/db';
import { compareStringsByCodeUnit } from '@alphred/shared';
import { CONTEXT_POLICY_VERSION, artifactContentTypes } from './constants.js';
import type {
  ContextEnvelopeEntry,
  ContextEnvelopeTruncation,
  RoutingDecisionType,
  RunNodeExecutionRow,
} from './types.js';

export function toRunNodeStatus(value: string): RunNodeStatus {
  return value as RunNodeStatus;
}

export function toWorkflowRunStatus(value: string): WorkflowRunStatus {
  return value as WorkflowRunStatus;
}

export function toRoutingDecisionType(value: string): RoutingDecisionType {
  switch (value) {
    case 'approved':
    case 'changes_requested':
    case 'blocked':
    case 'retry':
    case 'no_route':
      return value;
    default:
      throw new Error(`Unsupported routing decision type '${value}'.`);
  }
}

export function normalizeArtifactContentType(value: string | null): 'text' | 'markdown' | 'json' | 'diff' {
  if (value && artifactContentTypes.has(value)) {
    return value as 'text' | 'markdown' | 'json' | 'diff';
  }

  return 'markdown';
}

export function hashContentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function truncateHeadTail(content: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }

  if (content.length <= limit) {
    return content;
  }

  const headChars = Math.floor(limit / 2);
  const tailChars = limit - headChars;
  return `${content.slice(0, headChars)}${content.slice(content.length - tailChars)}`;
}

export function buildTruncationMetadata(originalChars: number, includedChars: number): ContextEnvelopeTruncation {
  const droppedChars = Math.max(originalChars - includedChars, 0);
  return {
    applied: droppedChars > 0,
    method: droppedChars > 0 ? 'head_tail' : 'none',
    originalChars,
    includedChars,
    droppedChars,
  };
}

export function serializeContextEnvelope(params: {
  workflowRunId: number;
  targetNodeKey: string;
  entry: ContextEnvelopeEntry;
}): string {
  const lines = [
    'ALPHRED_UPSTREAM_ARTIFACT v1',
    `policy_version: ${CONTEXT_POLICY_VERSION}`,
    'untrusted_data: true',
    `workflow_run_id: ${params.workflowRunId}`,
    `target_node_key: ${params.targetNodeKey}`,
    `source_node_key: ${params.entry.sourceNodeKey}`,
    `source_run_node_id: ${params.entry.sourceRunNodeId}`,
    `source_attempt: ${params.entry.sourceAttempt}`,
    `artifact_id: ${params.entry.artifactId}`,
    'artifact_type: report',
    `content_type: ${params.entry.contentType}`,
    `created_at: ${params.entry.createdAt}`,
    `sha256: ${params.entry.sha256}`,
    'truncation:',
    `  applied: ${params.entry.truncation.applied ? 'true' : 'false'}`,
    `  method: ${params.entry.truncation.method}`,
    `  original_chars: ${params.entry.truncation.originalChars}`,
    `  included_chars: ${params.entry.truncation.includedChars}`,
    `  dropped_chars: ${params.entry.truncation.droppedChars}`,
    'content:',
    '<<<BEGIN>>>',
  ];

  return `${lines.join('\n')}\n${params.entry.includedContent}\n<<<END>>>`;
}

export function serializeRetryFailureSummaryEnvelope(params: {
  workflowRunId: number;
  targetNodeKey: string;
  sourceAttempt: number;
  targetAttempt: number;
  summaryArtifactId: number;
  failureArtifactId: number | null;
  createdAt: string;
  includedContent: string;
  sha256: string;
  truncation: ContextEnvelopeTruncation;
}): string {
  const lines = [
    'ALPHRED_RETRY_FAILURE_SUMMARY v1',
    `policy_version: ${CONTEXT_POLICY_VERSION}`,
    'untrusted_data: true',
    `workflow_run_id: ${params.workflowRunId}`,
    `target_node_key: ${params.targetNodeKey}`,
    `source_attempt: ${params.sourceAttempt}`,
    `target_attempt: ${params.targetAttempt}`,
    `summary_artifact_id: ${params.summaryArtifactId}`,
    `failure_artifact_id: ${params.failureArtifactId === null ? 'null' : String(params.failureArtifactId)}`,
    `created_at: ${params.createdAt}`,
    `sha256: ${params.sha256}`,
    'truncation:',
    `  applied: ${params.truncation.applied ? 'true' : 'false'}`,
    `  method: ${params.truncation.method}`,
    `  original_chars: ${params.truncation.originalChars}`,
    `  included_chars: ${params.truncation.includedChars}`,
    `  dropped_chars: ${params.truncation.droppedChars}`,
    'content:',
    '<<<BEGIN>>>',
  ];

  return `${lines.join('\n')}\n${params.includedContent}\n<<<END>>>`;
}

export function serializeFailureRouteContextEnvelope(params: {
  workflowRunId: number;
  targetNodeKey: string;
  sourceNodeKey: string;
  sourceRunNodeId: number;
  sourceAttempt: number;
  failureArtifactId: number | null;
  retrySummaryArtifactId: number | null;
  createdAt: string;
  includedContent: string;
  truncation: ContextEnvelopeTruncation;
}): string {
  const lines = [
    'ALPHRED_FAILURE_ROUTE_CONTEXT v1',
    `policy_version: ${CONTEXT_POLICY_VERSION}`,
    'untrusted_data: true',
    `workflow_run_id: ${params.workflowRunId}`,
    `target_node_key: ${params.targetNodeKey}`,
    `source_node_key: ${params.sourceNodeKey}`,
    `source_run_node_id: ${params.sourceRunNodeId}`,
    `source_attempt: ${params.sourceAttempt}`,
    `failure_artifact_id: ${params.failureArtifactId === null ? 'null' : String(params.failureArtifactId)}`,
    `retry_summary_artifact_id: ${params.retrySummaryArtifactId === null ? 'null' : String(params.retrySummaryArtifactId)}`,
    `created_at: ${params.createdAt}`,
    'truncation:',
    `  applied: ${params.truncation.applied ? 'true' : 'false'}`,
    `  method: ${params.truncation.method}`,
    `  original_chars: ${params.truncation.originalChars}`,
    `  included_chars: ${params.truncation.includedChars}`,
    `  dropped_chars: ${params.truncation.droppedChars}`,
    'content:',
    '<<<BEGIN>>>',
  ];

  return `${lines.join('\n')}\n${params.includedContent}\n<<<END>>>`;
}

export function compareNodeOrder(a: RunNodeExecutionRow, b: RunNodeExecutionRow): number {
  const bySequence = a.sequenceIndex - b.sequenceIndex;
  if (bySequence !== 0) {
    return bySequence;
  }

  const byNodeKey = compareStringsByCodeUnit(a.nodeKey, b.nodeKey);
  if (byNodeKey !== 0) {
    return byNodeKey;
  }

  const byAttempt = a.attempt - b.attempt;
  if (byAttempt !== 0) {
    return byAttempt;
  }

  return a.runNodeId - b.runNodeId;
}

export function getLatestRunNodeAttempts(rows: RunNodeExecutionRow[]): RunNodeExecutionRow[] {
  const latestByNodeKey = new Map<string, RunNodeExecutionRow>();
  for (const row of rows) {
    const current = latestByNodeKey.get(row.nodeKey);
    if (!current || row.attempt > current.attempt || (row.attempt === current.attempt && row.runNodeId > current.runNodeId)) {
      latestByNodeKey.set(row.nodeKey, row);
    }
  }

  return [...latestByNodeKey.values()].sort(compareNodeOrder);
}

export function compareUpstreamSourceOrder(a: RunNodeExecutionRow, b: RunNodeExecutionRow): number {
  const bySequence = a.sequenceIndex - b.sequenceIndex;
  if (bySequence !== 0) {
    return bySequence;
  }

  const byNodeKey = compareStringsByCodeUnit(a.nodeKey, b.nodeKey);
  if (byNodeKey !== 0) {
    return byNodeKey;
  }

  return a.runNodeId - b.runNodeId;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
