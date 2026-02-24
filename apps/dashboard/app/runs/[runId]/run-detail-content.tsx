'use client';

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  DashboardRepositoryState,
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
  DashboardRunNodeStreamSnapshot,
  DashboardRunSummary,
} from '../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../ui/primitives';
import { isActiveRunStatus } from '../run-summary-utils';

type TimelineCategory = 'lifecycle' | 'node' | 'artifact' | 'diagnostics' | 'routing';

type TimelineItem = Readonly<{
  key: string;
  timestamp: Date;
  summary: string;
  relatedNodeId: number | null;
  category: TimelineCategory;
}>;

type PrimaryActionState = Readonly<{
  label: string;
  href: string | null;
  disabledReason: string | null;
}>;

type RealtimeChannelState = 'disabled' | 'live' | 'reconnecting' | 'stale';
type AgentStreamConnectionState = 'live' | 'reconnecting' | 'stale' | 'ended';
type DiagnosticErrorClassification = 'provider_result_missing' | 'timeout' | 'aborted' | 'unknown';

type AgentStreamTarget = {
  runNodeId: number;
  nodeKey: string;
  attempt: number;
};

type ExpandablePreviewProps = Readonly<{
  value: string;
  label: string;
  previewLength?: number;
  className?: string;
  emptyLabel?: string;
}>;

type RunDetailContentProps = Readonly<{
  initialDetail: DashboardRunDetail;
  repositories: readonly DashboardRepositoryState[];
  enableRealtime?: boolean;
  pollIntervalMs?: number;
}>;

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const RUN_STATUSES = new Set<DashboardRunSummary['status']>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
const NODE_STATUSES = new Set<DashboardRunDetail['nodes'][number]['status']>([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);
const ARTIFACT_TYPES = new Set<DashboardRunDetail['artifacts'][number]['artifactType']>([
  'report',
  'note',
  'log',
]);
const ARTIFACT_CONTENT_TYPES = new Set<DashboardRunDetail['artifacts'][number]['contentType']>([
  'text',
  'markdown',
  'json',
  'diff',
]);
const ROUTING_DECISION_TYPES = new Set<DashboardRunDetail['routingDecisions'][number]['decisionType']>([
  'approved',
  'changes_requested',
  'blocked',
  'retry',
  'no_route',
]);
const DIAGNOSTIC_OUTCOMES = new Set<DashboardRunDetail['diagnostics'][number]['outcome']>(['completed', 'failed']);
const DIAGNOSTIC_EVENT_TYPES = new Set<DashboardRunDetail['diagnostics'][number]['diagnostics']['events'][number]['type']>([
  'system',
  'assistant',
  'result',
  'tool_use',
  'tool_result',
  'usage',
]);
const DIAGNOSTIC_TOOL_EVENT_TYPES = new Set<DashboardRunDetail['diagnostics'][number]['diagnostics']['toolEvents'][number]['type']>([
  'tool_use',
  'tool_result',
]);
const DIAGNOSTIC_ERROR_CLASSIFICATIONS = new Set<DiagnosticErrorClassification>([
  'provider_result_missing',
  'timeout',
  'aborted',
  'unknown',
]);
const WORKTREE_STATUSES = new Set<DashboardRunDetail['worktrees'][number]['status']>(['active', 'removed']);
const STREAM_EVENT_TYPES = new Set<DashboardRunNodeStreamEvent['type']>([
  'system',
  'assistant',
  'result',
  'tool_use',
  'tool_result',
  'usage',
]);

export const RUN_DETAIL_POLL_INTERVAL_MS = 4_000;
const RUN_DETAIL_POLL_BACKOFF_MAX_MS = 20_000;
const RUN_DETAIL_STALE_THRESHOLD_MS = 15_000;
const AGENT_STREAM_RECONNECT_MAX_MS = 20_000;
const AGENT_STREAM_STALE_THRESHOLD_MS = 15_000;
const RUN_TIMELINE_RECENT_EVENT_COUNT = 8;
const RUN_AGENT_STREAM_RECENT_EVENT_COUNT = 8;
const RUN_OBSERVABILITY_RECENT_ENTRY_COUNT = 2;

type RecentPartition<T> = Readonly<{
  recent: readonly T[];
  earlier: readonly T[];
}>;
type RecentPartitionOrder = 'oldest-first' | 'newest-first';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function hasNodeStatusSummary(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isInteger(value.pending) &&
    isInteger(value.running) &&
    isInteger(value.completed) &&
    isInteger(value.failed) &&
    isInteger(value.skipped) &&
    isInteger(value.cancelled)
  );
}

function hasArtifactShape(value: unknown): value is DashboardRunDetail['artifacts'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isInteger(value.id) &&
    isInteger(value.runNodeId) &&
    typeof value.artifactType === 'string' &&
    ARTIFACT_TYPES.has(value.artifactType as DashboardRunDetail['artifacts'][number]['artifactType']) &&
    typeof value.contentType === 'string' &&
    ARTIFACT_CONTENT_TYPES.has(value.contentType as DashboardRunDetail['artifacts'][number]['contentType']) &&
    typeof value.contentPreview === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function hasRoutingDecisionShape(value: unknown): value is DashboardRunDetail['routingDecisions'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isInteger(value.id) &&
    isInteger(value.runNodeId) &&
    typeof value.decisionType === 'string' &&
    ROUTING_DECISION_TYPES.has(
      value.decisionType as DashboardRunDetail['routingDecisions'][number]['decisionType'],
    ) &&
    isNullableString(value.rationale) &&
    typeof value.createdAt === 'string'
  );
}

function hasDiagnosticsShape(value: unknown): value is DashboardRunDetail['diagnostics'][number] {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isInteger(value.id) ||
    !isInteger(value.runNodeId) ||
    !isInteger(value.attempt) ||
    typeof value.outcome !== 'string' ||
    !DIAGNOSTIC_OUTCOMES.has(value.outcome as DashboardRunDetail['diagnostics'][number]['outcome']) ||
    !isInteger(value.eventCount) ||
    !isInteger(value.retainedEventCount) ||
    !isInteger(value.droppedEventCount) ||
    !isBoolean(value.redacted) ||
    !isBoolean(value.truncated) ||
    !isInteger(value.payloadChars) ||
    typeof value.createdAt !== 'string' ||
    !isRecord(value.diagnostics)
  ) {
    return false;
  }

  const payload = value.diagnostics;
  if (
    !isInteger(payload.schemaVersion) ||
    !isInteger(payload.workflowRunId) ||
    !isInteger(payload.runNodeId) ||
    typeof payload.nodeKey !== 'string' ||
    !isInteger(payload.attempt) ||
    typeof payload.outcome !== 'string' ||
    !DIAGNOSTIC_OUTCOMES.has(payload.outcome as DashboardRunDetail['diagnostics'][number]['outcome']) ||
    typeof payload.status !== 'string' ||
    !DIAGNOSTIC_OUTCOMES.has(payload.status as DashboardRunDetail['diagnostics'][number]['outcome']) ||
    !isNullableString(payload.provider) ||
    !isRecord(payload.timing) ||
    !isRecord(payload.summary) ||
    !isRecord(payload.contextHandoff) ||
    !isRecord(payload.eventTypeCounts) ||
    !Array.isArray(payload.events) ||
    !Array.isArray(payload.toolEvents) ||
    !(payload.routingDecision === null || typeof payload.routingDecision === 'string') ||
    !(payload.error === null || isRecord(payload.error))
  ) {
    return false;
  }

  if (
    !isNullableString(payload.timing.queuedAt) ||
    !isNullableString(payload.timing.startedAt) ||
    !isNullableString(payload.timing.completedAt) ||
    !isNullableString(payload.timing.failedAt) ||
    typeof payload.timing.persistedAt !== 'string'
  ) {
    return false;
  }

  if (
    !isInteger(payload.summary.tokensUsed) ||
    !isInteger(payload.summary.eventCount) ||
    !isInteger(payload.summary.retainedEventCount) ||
    !isInteger(payload.summary.droppedEventCount) ||
    !isInteger(payload.summary.toolEventCount) ||
    !isBoolean(payload.summary.redacted) ||
    !isBoolean(payload.summary.truncated)
  ) {
    return false;
  }

  if (
    !payload.events.every((event) => {
      if (!isRecord(event)) {
        return false;
      }

      const usage = event.usage;
      if (usage !== null) {
        if (
          !isRecord(usage) ||
          !(usage.deltaTokens === null || isInteger(usage.deltaTokens)) ||
          !(usage.cumulativeTokens === null || isInteger(usage.cumulativeTokens))
        ) {
          return false;
        }
      }

      return (
        isInteger(event.eventIndex) &&
        typeof event.type === 'string' &&
        DIAGNOSTIC_EVENT_TYPES.has(
          event.type as DashboardRunDetail['diagnostics'][number]['diagnostics']['events'][number]['type'],
        ) &&
        isInteger(event.timestamp) &&
        isInteger(event.contentChars) &&
        typeof event.contentPreview === 'string' &&
        (event.metadata === null || isRecord(event.metadata))
      );
    })
  ) {
    return false;
  }

  if (
    !payload.toolEvents.every((event) => {
      if (!isRecord(event)) {
        return false;
      }

      return (
        isInteger(event.eventIndex) &&
        typeof event.type === 'string' &&
        DIAGNOSTIC_TOOL_EVENT_TYPES.has(
          event.type as DashboardRunDetail['diagnostics'][number]['diagnostics']['toolEvents'][number]['type'],
        ) &&
        isInteger(event.timestamp) &&
        isNullableString(event.toolName) &&
        typeof event.summary === 'string'
      );
    })
  ) {
    return false;
  }

  if (
    payload.error !== null &&
    (
      typeof payload.error.name !== 'string' ||
      typeof payload.error.message !== 'string' ||
      typeof payload.error.classification !== 'string' ||
      !DIAGNOSTIC_ERROR_CLASSIFICATIONS.has(payload.error.classification as DiagnosticErrorClassification) ||
      !isNullableString(payload.error.stackPreview)
    )
  ) {
    return false;
  }

  return true;
}

function hasRunNodeShape(value: unknown): value is DashboardRunDetail['nodes'][number] {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isInteger(value.id) ||
    !isInteger(value.treeNodeId) ||
    typeof value.nodeKey !== 'string' ||
    !isInteger(value.sequenceIndex) ||
    !isInteger(value.attempt) ||
    typeof value.status !== 'string' ||
    !NODE_STATUSES.has(value.status as DashboardRunDetail['nodes'][number]['status']) ||
    !isNullableString(value.startedAt) ||
    !isNullableString(value.completedAt)
  ) {
    return false;
  }

  if (value.latestArtifact !== null && !hasArtifactShape(value.latestArtifact)) {
    return false;
  }

  if (value.latestRoutingDecision !== null && !hasRoutingDecisionShape(value.latestRoutingDecision)) {
    return false;
  }

  if (value.latestDiagnostics !== null && !hasDiagnosticsShape(value.latestDiagnostics)) {
    return false;
  }

  return true;
}

function hasWorktreeShape(
  value: unknown,
  expectedRunId: number,
): value is DashboardRunDetail['worktrees'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isInteger(value.id) &&
    isInteger(value.runId) &&
    value.runId === expectedRunId &&
    isInteger(value.repositoryId) &&
    typeof value.path === 'string' &&
    typeof value.branch === 'string' &&
    isNullableString(value.commitHash) &&
    typeof value.status === 'string' &&
    WORKTREE_STATUSES.has(value.status as DashboardRunDetail['worktrees'][number]['status']) &&
    typeof value.createdAt === 'string' &&
    isNullableString(value.removedAt)
  );
}

function hasStreamEventShape(
  value: unknown,
  expectedRunId: number,
  expectedRunNodeId: number,
  expectedAttempt: number,
): value is DashboardRunNodeStreamEvent {
  if (!isRecord(value)) {
    return false;
  }

  const usage = value.usage;
  if (
    usage !== null &&
    (!isRecord(usage) ||
      !(usage.deltaTokens === null || isInteger(usage.deltaTokens)) ||
      !(usage.cumulativeTokens === null || isInteger(usage.cumulativeTokens)))
  ) {
    return false;
  }

  return (
    isInteger(value.id) &&
    isInteger(value.workflowRunId) &&
    value.workflowRunId === expectedRunId &&
    isInteger(value.runNodeId) &&
    value.runNodeId === expectedRunNodeId &&
    isInteger(value.attempt) &&
    value.attempt === expectedAttempt &&
    isInteger(value.sequence) &&
    value.sequence > 0 &&
    typeof value.type === 'string' &&
    STREAM_EVENT_TYPES.has(value.type as DashboardRunNodeStreamEvent['type']) &&
    isInteger(value.timestamp) &&
    isInteger(value.contentChars) &&
    typeof value.contentPreview === 'string' &&
    (value.metadata === null || isRecord(value.metadata)) &&
    typeof value.createdAt === 'string'
  );
}

function hasRunNodeStreamSnapshotShape(
  value: unknown,
  expectedRunId: number,
  expectedRunNodeId: number,
  expectedAttempt: number,
): value is DashboardRunNodeStreamSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isInteger(value.workflowRunId) ||
    value.workflowRunId !== expectedRunId ||
    !isInteger(value.runNodeId) ||
    value.runNodeId !== expectedRunNodeId ||
    !isInteger(value.attempt) ||
    value.attempt !== expectedAttempt ||
    typeof value.nodeStatus !== 'string' ||
    !NODE_STATUSES.has(value.nodeStatus as DashboardRunDetail['nodes'][number]['status']) ||
    !isBoolean(value.ended) ||
    !isInteger(value.latestSequence) ||
    value.latestSequence < 0 ||
    !Array.isArray(value.events)
  ) {
    return false;
  }

  return value.events.every(event =>
    hasStreamEventShape(event, expectedRunId, expectedRunNodeId, expectedAttempt),
  );
}

function hasRunSummaryShape(value: unknown, expectedRunId: number): value is DashboardRunDetail['run'] {
  if (!isRecord(value)) {
    return false;
  }

  if (!isInteger(value.id) || value.id !== expectedRunId) {
    return false;
  }

  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status as DashboardRunSummary['status'])) {
    return false;
  }

  if (!isNullableString(value.startedAt) || !isNullableString(value.completedAt) || typeof value.createdAt !== 'string') {
    return false;
  }

  const tree = value.tree;
  if (
    !isRecord(tree) ||
    !isInteger(tree.id) ||
    typeof tree.treeKey !== 'string' ||
    !isInteger(tree.version) ||
    typeof tree.name !== 'string'
  ) {
    return false;
  }

  const repository = value.repository;
  if (repository !== null && (!isRecord(repository) || !isInteger(repository.id) || typeof repository.name !== 'string')) {
    return false;
  }

  return hasNodeStatusSummary(value.nodeSummary);
}

function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ErrorEnvelope).error === 'object' &&
    (payload as ErrorEnvelope).error !== null &&
    typeof (payload as ErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

function parseRunDetailPayload(payload: unknown, expectedRunId: number): DashboardRunDetail | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (!hasRunSummaryShape(payload.run, expectedRunId)) {
    return null;
  }

  if (!Array.isArray(payload.nodes) || !payload.nodes.every((node) => hasRunNodeShape(node))) {
    return null;
  }

  if (!Array.isArray(payload.artifacts) || !payload.artifacts.every((artifact) => hasArtifactShape(artifact))) {
    return null;
  }

  if (
    !Array.isArray(payload.routingDecisions) ||
    !payload.routingDecisions.every((decision) => hasRoutingDecisionShape(decision))
  ) {
    return null;
  }

  if (!Array.isArray(payload.diagnostics) || !payload.diagnostics.every((diagnostics) => hasDiagnosticsShape(diagnostics))) {
    return null;
  }

  if (!Array.isArray(payload.worktrees) || !payload.worktrees.every((worktree) => hasWorktreeShape(worktree, expectedRunId))) {
    return null;
  }

  return payload as DashboardRunDetail;
}

function parseRunNodeStreamSnapshotPayload(
  payload: unknown,
  expectedRunId: number,
  expectedRunNodeId: number,
  expectedAttempt: number,
): DashboardRunNodeStreamSnapshot | null {
  if (!hasRunNodeStreamSnapshotShape(payload, expectedRunId, expectedRunNodeId, expectedAttempt)) {
    return null;
  }

  return payload;
}

function parseDateValue(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function padTwoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatUtcDateTime(value: Date): string {
  const year = value.getUTCFullYear();
  const month = padTwoDigits(value.getUTCMonth() + 1);
  const day = padTwoDigits(value.getUTCDate());
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());

  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

function formatUtcTime(value: Date): string {
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());
  return `${hour}:${minute}:${second} UTC`;
}

function formatDateTime(value: string | null, fallback: string, hasHydrated: boolean): string {
  const parsed = parseDateValue(value);
  if (parsed === null) {
    return fallback;
  }

  if (!hasHydrated) {
    return formatUtcDateTime(parsed);
  }

  return parsed.toLocaleString();
}

function formatTimelineTime(value: Date, hasHydrated: boolean): string {
  if (!hasHydrated) {
    return formatUtcTime(value);
  }

  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLastUpdated(value: number, hasHydrated: boolean): string {
  const parsed = new Date(value);
  if (!hasHydrated) {
    return formatUtcTime(parsed);
  }

  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function toNodeTerminalSummary(node: DashboardRunDetail['nodes'][number]): string {
  switch (node.status) {
    case 'completed':
      return `${node.nodeKey} completed.`;
    case 'failed':
      return `${node.nodeKey} failed.`;
    case 'cancelled':
      return `${node.nodeKey} was cancelled.`;
    case 'skipped':
      return `${node.nodeKey} was skipped.`;
    default:
      return `${node.nodeKey} finished with status ${node.status}.`;
  }
}

function isTerminalNodeStatus(status: DashboardRunDetail['nodes'][number]['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled';
}

function partitionByRecency<T>(
  items: readonly T[],
  recentCount: number,
  order: RecentPartitionOrder = 'oldest-first',
): RecentPartition<T> {
  if (recentCount <= 0 || items.length <= recentCount) {
    return {
      recent: [...items],
      earlier: [],
    };
  }

  if (order === 'newest-first') {
    return {
      recent: items.slice(0, recentCount),
      earlier: items.slice(recentCount),
    };
  }

  const splitIndex = items.length - recentCount;
  return {
    recent: items.slice(splitIndex),
    earlier: items.slice(0, splitIndex),
  };
}

const TIMELINE_CATEGORY_LABELS: Record<TimelineCategory, string> = {
  lifecycle: 'Lifecycle',
  node: 'Node',
  artifact: 'Artifact',
  diagnostics: 'Diagnostics',
  routing: 'Routing',
};

function TimelineCategoryIcon({ category }: { category: TimelineCategory }) {
  const iconProps = {
    'aria-hidden': true as const,
    focusable: 'false' as const,
    className: 'timeline-category-icon',
    width: 10,
    height: 10,
    viewBox: '0 0 10 10',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (category) {
    case 'lifecycle':
      return <svg {...iconProps}><circle cx="5" cy="5" r="3.5" /></svg>;
    case 'node':
      return <svg {...iconProps}><path d="M2 5h6M6 3l2 2-2 2" /></svg>;
    case 'artifact':
      return <svg {...iconProps}><rect x="2" y="1.5" width="6" height="7" rx="1" /></svg>;
    case 'diagnostics':
      return <svg {...iconProps}><path d="M5 1.5L8.5 8H1.5z" /></svg>;
    case 'routing':
      return <svg {...iconProps}><path d="M5 1l3.5 4L5 9 1.5 5z" /></svg>;
  }
}

function buildTimeline(detail: DashboardRunDetail): readonly TimelineItem[] {
  const fallbackDate = parseDateValue(detail.run.createdAt) ?? new Date(0);
  const events: TimelineItem[] = [];

  const startedAt = parseDateValue(detail.run.startedAt);
  if (startedAt) {
    events.push({
      key: `run-start-${detail.run.id}`,
      timestamp: startedAt,
      summary: 'Run started.',
      relatedNodeId: null,
      category: 'lifecycle',
    });
  }

  const completedAt = parseDateValue(detail.run.completedAt);
  if (completedAt) {
    events.push({
      key: `run-terminal-${detail.run.id}`,
      timestamp: completedAt,
      summary: `Run reached terminal state (${detail.run.status}).`,
      relatedNodeId: null,
      category: 'lifecycle',
    });
  }

  for (const node of detail.nodes) {
    const nodeStartedAt = parseDateValue(node.startedAt);
    if (nodeStartedAt) {
      events.push({
        key: `node-start-${node.id}`,
        timestamp: nodeStartedAt,
        summary: `${node.nodeKey} started (attempt ${node.attempt}).`,
        relatedNodeId: node.id,
        category: 'node',
      });
    }

    const nodeCompletedAt = parseDateValue(node.completedAt);
    if (nodeCompletedAt) {
      events.push({
        key: `node-terminal-${node.id}`,
        timestamp: nodeCompletedAt,
        summary: toNodeTerminalSummary(node),
        relatedNodeId: node.id,
        category: 'node',
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const createdAt = parseDateValue(artifact.createdAt) ?? fallbackDate;
    events.push({
      key: `artifact-${artifact.id}`,
      timestamp: createdAt,
      summary: `Artifact captured (${artifact.artifactType}/${artifact.contentType}).`,
      relatedNodeId: artifact.runNodeId,
      category: 'artifact',
    });
  }

  for (const decision of detail.routingDecisions) {
    const createdAt = parseDateValue(decision.createdAt) ?? fallbackDate;
    events.push({
      key: `decision-${decision.id}`,
      timestamp: createdAt,
      summary: `Routing decision: ${decision.decisionType}.`,
      relatedNodeId: decision.runNodeId,
      category: 'routing',
    });
  }

  for (const diagnostics of detail.diagnostics) {
    const createdAt = parseDateValue(diagnostics.createdAt) ?? fallbackDate;
    events.push({
      key: `diagnostics-${diagnostics.id}`,
      timestamp: createdAt,
      summary: `Diagnostics persisted (attempt ${diagnostics.attempt}, ${diagnostics.outcome}).`,
      relatedNodeId: diagnostics.runNodeId,
      category: 'diagnostics',
    });
  }

  return events.sort((left, right) => {
    const timeDifference = left.timestamp.getTime() - right.timestamp.getTime();
    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.key.localeCompare(right.key);
  });
}

function resolveRepositoryContext(
  detail: DashboardRunDetail,
  repositories: readonly DashboardRepositoryState[],
): string {
  if (detail.worktrees.length === 0) {
    return 'Not attached';
  }

  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]));
  const repositoryContextWorktree =
    detail.worktrees.find((worktree) => worktree.status === 'active') ??
    detail.worktrees.at(-1);
  if (!repositoryContextWorktree) {
    return 'Not attached';
  }

  return (
    repositoryNameById.get(repositoryContextWorktree.repositoryId) ??
    `Repository #${repositoryContextWorktree.repositoryId}`
  );
}

function resolvePrimaryAction(
  run: DashboardRunSummary,
  hasWorktree: boolean,
): PrimaryActionState {
  if (run.status === 'completed') {
    if (hasWorktree) {
      return {
        label: 'Open Worktree',
        href: `/runs/${run.id}/worktree`,
        disabledReason: null,
      };
    }

    return {
      label: 'Open Worktree',
      href: null,
      disabledReason: 'No worktree was captured for this run.',
    };
  }

  if (run.status === 'running') {
    return {
      label: 'Pause',
      href: null,
      disabledReason: 'Pause action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'paused') {
    return {
      label: 'Resume',
      href: null,
      disabledReason: 'Resume action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'failed') {
    return {
      label: 'Retry Failed Node',
      href: null,
      disabledReason: 'Retry action is blocked until retry controls are available.',
    };
  }

  if (run.status === 'pending') {
    return {
      label: 'Pending Start',
      href: null,
      disabledReason: 'Run has not started yet.',
    };
  }

  return {
    label: 'Run Cancelled',
    href: null,
    disabledReason: 'Cancelled runs cannot be resumed from this view.',
  };
}

function truncatePreview(value: string, previewLength = 140): string {
  const normalized = value.trim();
  if (normalized.length <= previewLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, previewLength - 3))}...`;
}

function hasTruncatedPreview(value: string, previewLength = 140): boolean {
  return value.trim().length > previewLength;
}

function ExpandablePreview({
  value,
  label,
  previewLength = 140,
  className = 'meta-text',
  emptyLabel = '(no content)',
}: ExpandablePreviewProps) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return <p className={className}>{emptyLabel}</p>;
  }

  const preview = truncatePreview(normalized, previewLength);
  if (!hasTruncatedPreview(normalized, previewLength)) {
    return <p className={className}>{preview}</p>;
  }

  return (
    <div className="run-expandable-preview">
      <p className={className}>{preview}</p>
      <details className="run-expandable-preview__details">
        <summary className="run-expandable-preview__summary">{`Show full ${label}`}</summary>
        <p className={className}>{normalized}</p>
      </details>
    </div>
  );
}

function resolveRealtimeLabel(
  state: RealtimeChannelState,
  pollIntervalMs: number,
  retryCountdownSeconds: number | null,
): { badgeLabel: string; detail: string } {
  if (state === 'disabled') {
    return {
      badgeLabel: 'Idle',
      detail: 'Realtime updates are paused for this run state.',
    };
  }

  if (state === 'live') {
    return {
      badgeLabel: 'Live',
      detail: `Live updates every ${Math.max(1, Math.floor(pollIntervalMs / 1000))}s (bounded polling fallback).`,
    };
  }

  if (state === 'reconnecting') {
    return {
      badgeLabel: 'Reconnecting',
      detail: `Connection interrupted. Retrying in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  return {
    badgeLabel: 'Stale',
    detail: `Latest data is stale. Reconnect attempt in ${retryCountdownSeconds ?? 0}s.`,
  };
}

function resolveAgentStreamLabel(
  state: AgentStreamConnectionState,
  retryCountdownSeconds: number | null,
): { badgeLabel: string; detail: string } {
  if (state === 'live') {
    return {
      badgeLabel: 'Live',
      detail: 'Agent stream is connected and receiving events in real time.',
    };
  }

  if (state === 'reconnecting') {
    return {
      badgeLabel: 'Reconnecting',
      detail: `Agent stream connection interrupted. Retrying in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  if (state === 'stale') {
    return {
      badgeLabel: 'Stale',
      detail: `Agent stream is stale. Reconnect attempt in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  return {
    badgeLabel: 'Ended',
    detail: 'Node attempt reached terminal state; stream is closed.',
  };
}

function formatStreamTimestamp(value: number): string {
  if (value >= 1_000_000_000_000) {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return `t=${value}`;
}

function resolveInitialLastUpdatedAtMs(detail: DashboardRunDetail): number {
  const fallbackDate = parseDateValue(detail.run.createdAt);
  const startedAt = parseDateValue(detail.run.startedAt);
  const completedAt = parseDateValue(detail.run.completedAt);

  return completedAt?.getTime() ?? startedAt?.getTime() ?? fallbackDate?.getTime() ?? 0;
}

function resolveInitialStreamLastUpdatedAtMs(detail: DashboardRunDetail): number {
  const runningNode = detail.nodes.find((node) => node.status === 'running');
  const fallbackNode = runningNode ?? detail.nodes[0];
  if (fallbackNode) {
    const completedAt = parseDateValue(fallbackNode.completedAt);
    const startedAt = parseDateValue(fallbackNode.startedAt);
    if (completedAt) {
      return completedAt.getTime();
    }
    if (startedAt) {
      return startedAt.getTime();
    }
  }

  return resolveInitialLastUpdatedAtMs(detail);
}

function toAgentStreamTarget(node: DashboardRunDetail['nodes'][number]): AgentStreamTarget {
  return {
    runNodeId: node.id,
    nodeKey: node.nodeKey,
    attempt: node.attempt,
  };
}

function resolveInitialAgentStreamTarget(detail: DashboardRunDetail): AgentStreamTarget | null {
  const runningNode = detail.nodes.find(node => node.status === 'running');
  if (runningNode) {
    return toAgentStreamTarget(runningNode);
  }

  const firstNode = detail.nodes[0];
  return firstNode ? toAgentStreamTarget(firstNode) : null;
}

function mergeAgentStreamEvents(
  existingEvents: readonly DashboardRunNodeStreamEvent[],
  incomingEvents: readonly DashboardRunNodeStreamEvent[],
): DashboardRunNodeStreamEvent[] {
  if (incomingEvents.length === 0) {
    return [...existingEvents];
  }

  const bySequence = new Map<number, DashboardRunNodeStreamEvent>();
  for (const event of existingEvents) {
    bySequence.set(event.sequence, event);
  }
  for (const event of incomingEvents) {
    bySequence.set(event.sequence, event);
  }

  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

function syncSelectionStateWithNodes(params: {
  nodes: DashboardRunDetail['nodes'];
  highlightedNodeId: number | null;
  filteredNodeId: number | null;
  streamTarget: AgentStreamTarget | null;
  setHighlightedNodeId: StateSetter<number | null>;
  setFilteredNodeId: StateSetter<number | null>;
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
}): void {
  const {
    nodes,
    highlightedNodeId,
    filteredNodeId,
    streamTarget,
    setHighlightedNodeId,
    setFilteredNodeId,
    setStreamTarget,
  } = params;

  if (highlightedNodeId !== null && !nodes.some((node) => node.id === highlightedNodeId)) {
    setHighlightedNodeId(null);
  }

  if (filteredNodeId !== null && !nodes.some((node) => node.id === filteredNodeId)) {
    setFilteredNodeId(null);
  }

  if (streamTarget === null) {
    return;
  }

  const updatedNode = nodes.find((node) => node.id === streamTarget.runNodeId);
  if (!updatedNode) {
    setStreamTarget(null);
    return;
  }

  if (updatedNode.attempt !== streamTarget.attempt || updatedNode.nodeKey !== streamTarget.nodeKey) {
    setStreamTarget(toAgentStreamTarget(updatedNode));
  }
}

type RunDetailPollingEffectParams = {
  enableRealtime: boolean;
  runId: number;
  runStatus: DashboardRunSummary['status'];
  pollIntervalMs: number;
  lastUpdatedAtRef: { current: number };
  setChannelState: StateSetter<RealtimeChannelState>;
  setIsRefreshing: StateSetter<boolean>;
  setNextRetryAtMs: StateSetter<number | null>;
  setUpdateError: StateSetter<string | null>;
  setDetail: StateSetter<DashboardRunDetail>;
  setLastUpdatedAtMs: StateSetter<number>;
};

function createRunDetailPollingEffect(params: RunDetailPollingEffectParams): () => void {
  const {
    enableRealtime,
    runId,
    runStatus,
    pollIntervalMs,
    lastUpdatedAtRef,
    setChannelState,
    setIsRefreshing,
    setNextRetryAtMs,
    setUpdateError,
    setDetail,
    setLastUpdatedAtMs,
  } = params;

  if (!enableRealtime || !isActiveRunStatus(runStatus)) {
    setChannelState('disabled');
    setIsRefreshing(false);
    setNextRetryAtMs(null);
    setUpdateError(null);
    return () => undefined;
  }

  let cancelled = false;
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let consecutiveFailures = 0;

  const shouldSkipUpdate = (): boolean => cancelled || abortController.signal.aborted;
  const scheduleNextPoll = (delayMs: number): void => {
    timeoutId = globalThis.setTimeout(() => {
      void pollRunDetail();
    }, delayMs);
  };

  const fetchLatestRunDetail = async (): Promise<DashboardRunDetail | null> => {
    const response = await fetch(`/api/dashboard/runs/${runId}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: abortController.signal,
    });
    if (shouldSkipUpdate()) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    if (shouldSkipUpdate()) {
      return null;
    }
    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh run timeline'));
    }

    const parsedDetail = parseRunDetailPayload(payload, runId);
    if (parsedDetail === null) {
      throw new Error('Realtime run detail response was malformed.');
    }

    return shouldSkipUpdate() ? null : parsedDetail;
  };

  const applySuccessfulPoll = (parsedDetail: DashboardRunDetail): void => {
    consecutiveFailures = 0;
    setDetail(parsedDetail);
    setUpdateError(null);
    setIsRefreshing(false);
    setLastUpdatedAtMs(Date.now());
    setNextRetryAtMs(null);

    if (!isActiveRunStatus(parsedDetail.run.status)) {
      setChannelState('disabled');
      return;
    }

    setChannelState('live');
    if (!cancelled) {
      scheduleNextPoll(pollIntervalMs);
    }
  };

  const handlePollFailure = (error: unknown): void => {
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    if (shouldSkipUpdate() || isAbortError) {
      return;
    }

    consecutiveFailures += 1;
    const retryDelayMs = Math.min(
      pollIntervalMs * 2 ** Math.max(0, consecutiveFailures - 1),
      RUN_DETAIL_POLL_BACKOFF_MAX_MS,
    );
    const retryAt = Date.now() + retryDelayMs;
    const stale = Date.now() - lastUpdatedAtRef.current >= RUN_DETAIL_STALE_THRESHOLD_MS;

    setChannelState(stale ? 'stale' : 'reconnecting');
    setNextRetryAtMs(retryAt);
    setIsRefreshing(false);
    setUpdateError(error instanceof Error ? error.message : 'Unable to refresh run timeline.');

    if (!cancelled) {
      scheduleNextPoll(retryDelayMs);
    }
  };

  const pollRunDetail = async (): Promise<void> => {
    if (shouldSkipUpdate()) {
      return;
    }

    setIsRefreshing(true);
    try {
      const parsedDetail = await fetchLatestRunDetail();
      if (parsedDetail === null) {
        return;
      }

      applySuccessfulPoll(parsedDetail);
    } catch (error) {
      handlePollFailure(error);
    }
  };

  scheduleNextPoll(pollIntervalMs);

  return () => {
    cancelled = true;
    abortController.abort();
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  };
}

type AgentStreamLifecycleEffectParams = {
  runId: number;
  streamTarget: AgentStreamTarget | null;
  streamAutoScrollRef: { current: boolean };
  streamLastSequenceRef: { current: number };
  streamLastUpdatedAtRef: { current: number };
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamConnectionState: StateSetter<AgentStreamConnectionState>;
  setStreamError: StateSetter<string | null>;
  setStreamNextRetryAtMs: StateSetter<number | null>;
  setStreamRetryCountdownSeconds: StateSetter<number | null>;
  setStreamLastUpdatedAtMs: StateSetter<number>;
};

function resetAgentStreamState(params: {
  setStreamConnectionState: StateSetter<AgentStreamConnectionState>;
  setStreamError: StateSetter<string | null>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamNextRetryAtMs: StateSetter<number | null>;
  setStreamRetryCountdownSeconds: StateSetter<number | null>;
  streamLastSequenceRef: { current: number };
}): void {
  const {
    setStreamConnectionState,
    setStreamError,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamNextRetryAtMs,
    setStreamRetryCountdownSeconds,
    streamLastSequenceRef,
  } = params;

  setStreamConnectionState('ended');
  setStreamError(null);
  setStreamEvents([]);
  setStreamBufferedEvents([]);
  setStreamNextRetryAtMs(null);
  setStreamRetryCountdownSeconds(null);
  streamLastSequenceRef.current = 0;
}

function buildAgentStreamUrl(
  runId: number,
  target: AgentStreamTarget,
  transport: 'snapshot' | 'sse',
  lastEventSequence: number,
): string {
  const searchParams = new URLSearchParams({
    attempt: String(target.attempt),
    lastEventSequence: String(lastEventSequence),
  });
  if (transport === 'sse') {
    searchParams.set('transport', 'sse');
  }
  return `/api/dashboard/runs/${runId}/nodes/${target.runNodeId}/stream?${searchParams.toString()}`;
}

async function fetchAgentStreamSnapshot(
  runId: number,
  target: AgentStreamTarget,
  resumeFromSequence: number,
): Promise<DashboardRunNodeStreamSnapshot> {
  const response = await fetch(buildAgentStreamUrl(runId, target, 'snapshot', resumeFromSequence), {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to load agent stream history'));
  }

  const parsed = parseRunNodeStreamSnapshotPayload(payload, runId, target.runNodeId, target.attempt);
  if (parsed === null) {
    throw new Error('Realtime agent stream response was malformed.');
  }

  return parsed;
}

function parseMessageEventPayload(rawEvent: Event): unknown {
  const messageEvent = rawEvent as MessageEvent<string>;
  try {
    return JSON.parse(messageEvent.data);
  } catch {
    return null;
  }
}

function resolveLatestStreamSequence(
  events: readonly DashboardRunNodeStreamEvent[],
  fallback: number,
): number {
  return events.at(-1)?.sequence ?? fallback;
}

function appendIncomingAgentStreamEvents(params: {
  incomingEvents: readonly DashboardRunNodeStreamEvent[];
  streamLastSequenceRef: { current: number };
  streamAutoScrollRef: { current: boolean };
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamLastUpdatedAtMs: StateSetter<number>;
}): void {
  const {
    incomingEvents,
    streamLastSequenceRef,
    streamAutoScrollRef,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamLastUpdatedAtMs,
  } = params;
  if (incomingEvents.length === 0) {
    return;
  }

  const unseen = incomingEvents.filter((event) => event.sequence > streamLastSequenceRef.current);
  if (unseen.length === 0) {
    return;
  }

  const latestUnseenSequence = unseen.at(-1)?.sequence;
  if (latestUnseenSequence !== undefined) {
    streamLastSequenceRef.current = latestUnseenSequence;
  }
  setStreamLastUpdatedAtMs(Date.now());

  if (streamAutoScrollRef.current) {
    setStreamEvents((previous) => mergeAgentStreamEvents(previous, unseen));
    return;
  }

  setStreamBufferedEvents((previous) => mergeAgentStreamEvents(previous, unseen));
}

function createAgentStreamLifecycleEffect(params: AgentStreamLifecycleEffectParams): () => void {
  const {
    runId,
    streamTarget,
    streamAutoScrollRef,
    streamLastSequenceRef,
    streamLastUpdatedAtRef,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamConnectionState,
    setStreamError,
    setStreamNextRetryAtMs,
    setStreamRetryCountdownSeconds,
    setStreamLastUpdatedAtMs,
  } = params;
  if (streamTarget === null) {
    resetAgentStreamState({
      setStreamConnectionState,
      setStreamError,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamNextRetryAtMs,
      setStreamRetryCountdownSeconds,
      streamLastSequenceRef,
    });
    return () => undefined;
  }

  if (typeof EventSource === 'undefined') {
    setStreamConnectionState('stale');
    setStreamError('Agent stream is unavailable in this environment.');
    return () => undefined;
  }

  const target = streamTarget;
  let disposed = false;
  let reconnectTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let source: EventSource | null = null;
  let reconnectFailures = 0;
  let latestNodeStatus: DashboardRunDetail['nodes'][number]['status'] = 'running';
  let streamEnded = false;

  const closeSource = (): void => {
    if (source !== null) {
      source.close();
      source = null;
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  };

  const appendIncomingEvents = (incomingEvents: readonly DashboardRunNodeStreamEvent[]): void => {
    appendIncomingAgentStreamEvents({
      incomingEvents,
      streamLastSequenceRef,
      streamAutoScrollRef,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamLastUpdatedAtMs,
    });
  };

  const handleReconnect = (): void => {
    if (disposed) {
      return;
    }

    reconnectFailures += 1;
    const retryDelayMs = Math.min(1_000 * 2 ** Math.max(0, reconnectFailures - 1), AGENT_STREAM_RECONNECT_MAX_MS);
    const retryAt = Date.now() + retryDelayMs;
    const stale = Date.now() - streamLastUpdatedAtRef.current >= AGENT_STREAM_STALE_THRESHOLD_MS;
    setStreamConnectionState(stale ? 'stale' : 'reconnecting');
    setStreamNextRetryAtMs(retryAt);
    clearReconnectTimer();
    reconnectTimeoutId = globalThis.setTimeout(() => {
      void connectEventSource();
    }, retryDelayMs);
  };

  const connectEventSource = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    closeSource();
    source = new EventSource(buildAgentStreamUrl(runId, target, 'sse', streamLastSequenceRef.current));

    source.onopen = () => {
      if (disposed) {
        return;
      }

      reconnectFailures = 0;
      setStreamConnectionState('live');
      setStreamError(null);
      setStreamNextRetryAtMs(null);
    };

    source.addEventListener('stream_event', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (!hasStreamEventShape(payload, runId, target.runNodeId, target.attempt)) {
        setStreamError('Agent stream event payload was malformed.');
        return;
      }

      appendIncomingEvents([payload]);
    });

    source.addEventListener('stream_state', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (!isRecord(payload)) {
        return;
      }

      const connectionState = payload.connectionState;
      if (connectionState === 'live' || connectionState === 'ended') {
        setStreamConnectionState(connectionState);
      }

      if (typeof payload.nodeStatus === 'string') {
        latestNodeStatus = payload.nodeStatus as DashboardRunDetail['nodes'][number]['status'];
      }
    });

    source.addEventListener('stream_end', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (isRecord(payload) && typeof payload.nodeStatus === 'string') {
        latestNodeStatus = payload.nodeStatus as DashboardRunDetail['nodes'][number]['status'];
      }

      streamEnded = true;
      setStreamConnectionState('ended');
      setStreamError(null);
      setStreamNextRetryAtMs(null);
      closeSource();
    });

    source.addEventListener('stream_error', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (isRecord(payload) && typeof payload.message === 'string') {
        setStreamError(payload.message);
        return;
      }

      setStreamError('Agent stream channel reported an error.');
    });

    source.onerror = () => {
      closeSource();
      if (disposed || streamEnded) {
        return;
      }
      setStreamError(`Agent stream connection dropped for ${target.nodeKey} (attempt ${target.attempt}).`);
      handleReconnect();
    };
  };

  const initializeStream = async (): Promise<void> => {
    try {
      setStreamConnectionState('reconnecting');
      setStreamError(null);
      setStreamEvents([]);
      setStreamBufferedEvents([]);
      setStreamNextRetryAtMs(null);
      setStreamRetryCountdownSeconds(null);
      setStreamLastUpdatedAtMs(Date.now());
      streamLastSequenceRef.current = 0;

      let snapshot = await fetchAgentStreamSnapshot(runId, target, 0);
      let mergedEvents = mergeAgentStreamEvents([], snapshot.events);
      let resumeSequence = resolveLatestStreamSequence(mergedEvents, 0);
      while (snapshot.latestSequence > resumeSequence && snapshot.events.length > 0 && !disposed) {
        snapshot = await fetchAgentStreamSnapshot(runId, target, resumeSequence);
        mergedEvents = mergeAgentStreamEvents(mergedEvents, snapshot.events);
        resumeSequence = resolveLatestStreamSequence(mergedEvents, resumeSequence);
      }

      if (disposed) {
        return;
      }

      latestNodeStatus = snapshot.nodeStatus;
      streamLastSequenceRef.current = resumeSequence;
      setStreamEvents(mergedEvents);
      setStreamLastUpdatedAtMs(Date.now());

      if (snapshot.ended || isTerminalNodeStatus(latestNodeStatus)) {
        streamEnded = true;
        setStreamConnectionState('ended');
        setStreamError(null);
        return;
      }

      await connectEventSource();
    } catch (error) {
      if (disposed) {
        return;
      }

      setStreamError(error instanceof Error ? error.message : 'Unable to initialize agent stream.');
      handleReconnect();
    }
  };

  void initializeStream();

  return () => {
    disposed = true;
    clearReconnectTimer();
    closeSource();
  };
}

function resolvePayloadStorageSummary(diagnostics: DashboardRunDetail['diagnostics'][number]): string {
  if (!diagnostics.truncated && !diagnostics.redacted) {
    return 'Payload stored without truncation.';
  }

  const normalizationActions: string[] = [];
  if (diagnostics.redacted) {
    normalizationActions.push('redaction');
  }
  if (diagnostics.truncated) {
    normalizationActions.push('truncation');
  }

  return `Payload normalized with ${normalizationActions.join(' and ')}.`;
}

type RunAgentStreamCardProps = Readonly<{
  detail: DashboardRunDetail;
  streamTarget: AgentStreamTarget | null;
  selectedStreamNode: DashboardRunDetail['nodes'][number] | null;
  agentStreamLabel: ReturnType<typeof resolveAgentStreamLabel>;
  streamConnectionState: AgentStreamConnectionState;
  streamLastUpdatedAtMs: number;
  hasHydrated: boolean;
  streamAutoScroll: boolean;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  streamError: string | null;
  streamEvents: readonly DashboardRunNodeStreamEvent[];
  streamEventListRef: { current: HTMLOListElement | null };
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}>;

function RunAgentStreamCard({
  detail,
  streamTarget,
  selectedStreamNode,
  agentStreamLabel,
  streamConnectionState,
  streamLastUpdatedAtMs,
  hasHydrated,
  streamAutoScroll,
  streamBufferedEvents,
  streamError,
  streamEvents,
  streamEventListRef,
  setStreamTarget,
  setStreamAutoScroll,
  setStreamBufferedEvents,
  setStreamEvents,
}: RunAgentStreamCardProps) {
  const streamEventPartition = partitionByRecency(streamEvents, RUN_AGENT_STREAM_RECENT_EVENT_COUNT);

  const renderStreamEvent = (event: DashboardRunNodeStreamEvent) => (
    <li key={`${event.runNodeId}-${event.attempt}-${event.sequence}`} className="run-agent-stream-event">
      <p className="meta-text">{`#${event.sequence} · ${formatStreamTimestamp(event.timestamp)}`}</p>
      <p>
        <span className={`run-agent-stream-event-type run-agent-stream-event-type--${event.type}`}>{event.type}</span>
      </p>
      <ExpandablePreview
        value={event.contentPreview}
        label="event payload"
        previewLength={160}
        className="run-agent-stream-event-content"
      />
      {event.usage ? (
        <p className="meta-text">
          {`Usage Δ ${event.usage.deltaTokens ?? 'n/a'} · cumulative ${event.usage.cumulativeTokens ?? 'n/a'}`}
        </p>
      ) : null}
    </li>
  );

  return (
    <Card title="Agent stream" description="Live provider events for a selected node attempt.">
      <ul className="entity-list run-node-status-list" aria-label="Agent stream targets">
        {detail.nodes.length > 0 ? (
          detail.nodes.map((node) => {
            const selected = streamTarget?.runNodeId === node.id && streamTarget.attempt === node.attempt;
            const canOpenStream = node.status === 'running' || node.status === 'completed' || node.status === 'failed';

            return (
              <li key={`stream-target-${node.id}-${node.attempt}`}>
                <ActionButton
                  className={`run-node-filter${selected ? ' run-node-filter--selected' : ''}`}
                  aria-pressed={selected}
                  disabled={!canOpenStream}
                  onClick={() => {
                    setStreamTarget(toAgentStreamTarget(node));
                    setStreamAutoScroll(true);
                    setStreamBufferedEvents([]);
                  }}
                >
                  {`${node.nodeKey} (attempt ${node.attempt})`}
                </ActionButton>
                <StatusBadge status={node.status} />
              </li>
            );
          })
        ) : (
          <li>
            <span>No run nodes have been materialized yet.</span>
          </li>
        )}
      </ul>

      {selectedStreamNode ? (
        <>
          <output className={`run-realtime-status run-realtime-status--${streamConnectionState}`} aria-live="polite">
            <span className="run-realtime-status__badge">{agentStreamLabel.badgeLabel}</span>
            <span className="meta-text">{agentStreamLabel.detail}</span>
            <span className="meta-text">
              {`Node ${selectedStreamNode.nodeKey} (attempt ${selectedStreamNode.attempt}) · last update ${formatLastUpdated(streamLastUpdatedAtMs, hasHydrated)}.`}
            </span>
          </output>

          <div className="action-row run-agent-stream-controls">
            <ActionButton
              onClick={() => {
                if (streamAutoScroll) {
                  setStreamAutoScroll(false);
                  return;
                }

                setStreamAutoScroll(true);
                setStreamEvents(previous => mergeAgentStreamEvents(previous, streamBufferedEvents));
                setStreamBufferedEvents([]);
              }}
            >
              {streamAutoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            </ActionButton>
            {streamBufferedEvents.length > 0 ? (
              <span className="meta-text">{`${streamBufferedEvents.length} new events buffered.`}</span>
            ) : null}
          </div>

          {streamError && (streamConnectionState === 'reconnecting' || streamConnectionState === 'stale') ? (
            <output className="run-realtime-warning" aria-live="polite">
              {`Agent stream degraded: ${streamError}`}
            </output>
          ) : null}

          <ol ref={streamEventListRef} className="page-stack run-agent-stream-events" aria-label="Agent stream events">
            {streamEvents.length > 0 ? (
              <>
                {streamEventPartition.earlier.length > 0 ? (
                  <li>
                    <details className="run-collapsible-history">
                      <summary className="run-collapsible-history__summary">
                        {`Show ${streamEventPartition.earlier.length} earlier stream events`}
                      </summary>
                      <ol className="page-stack run-collapsible-history__list" aria-label="Earlier agent stream events">
                        {streamEventPartition.earlier.map((event) => renderStreamEvent(event))}
                      </ol>
                    </details>
                  </li>
                ) : null}
                {streamEventPartition.recent.map((event) => renderStreamEvent(event))}
              </>
            ) : (
              <li>
                <p>No streamed events captured yet for this node attempt.</p>
              </li>
            )}
          </ol>
        </>
      ) : (
        <p>Select a running node to open its Agent Stream panel.</p>
      )}
    </Card>
  );
}

type RunObservabilityCardProps = Readonly<{
  detail: DashboardRunDetail;
}>;

function RunObservabilityCard({ detail }: RunObservabilityCardProps) {
  const artifactPartition = partitionByRecency(detail.artifacts, RUN_OBSERVABILITY_RECENT_ENTRY_COUNT, 'newest-first');
  const diagnosticsPartition = partitionByRecency(
    detail.diagnostics,
    RUN_OBSERVABILITY_RECENT_ENTRY_COUNT,
    'newest-first',
  );

  const renderDiagnosticsEntry = (
    diagnostics: DashboardRunDetail['diagnostics'][number],
  ) => {
    const node = detail.nodes.find((candidate) => candidate.id === diagnostics.runNodeId);
    const nodeLabel = node ? `${node.nodeKey} (attempt ${diagnostics.attempt})` : `Node #${diagnostics.runNodeId}`;
    const payloadStorageSummary = resolvePayloadStorageSummary(diagnostics);

    return (
      <li key={diagnostics.id}>
        <p>{`${nodeLabel}: ${diagnostics.outcome}`}</p>
        <p className="meta-text">
          {`Events ${diagnostics.retainedEventCount}/${diagnostics.eventCount}; tools ${diagnostics.diagnostics.summary.toolEventCount}; tokens ${diagnostics.diagnostics.summary.tokensUsed}.`}
        </p>
        <p className="meta-text">{payloadStorageSummary}</p>
        {diagnostics.diagnostics.error ? (
          <ExpandablePreview
            value={`Failure: ${diagnostics.diagnostics.error.classification} (${diagnostics.diagnostics.error.message}).`}
            label="failure diagnostics"
          />
        ) : null}
        {diagnostics.diagnostics.toolEvents.length > 0 ? (
          <ExpandablePreview
            value={`Tool activity: ${diagnostics.diagnostics.toolEvents.map(event => event.summary).join('; ')}`}
            label="tool activity"
          />
        ) : null}
      </li>
    );
  };

  return (
    <Card title="Observability">
      <section className="run-observability-section">
        <p className="meta-text">Artifacts</p>
        {detail.artifacts.length === 0 ? <p>No artifacts captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run artifacts">
          {artifactPartition.recent.map((artifact) => {
            const node = detail.nodes.find((candidate) => candidate.id === artifact.runNodeId);
            const nodeLabel = node ? node.nodeKey : `node-${artifact.runNodeId}`;
            return (
              <li key={artifact.id}>
                <p>{`${nodeLabel} · ${artifact.artifactType} (${artifact.contentType})`}</p>
                <ExpandablePreview value={artifact.contentPreview} label="artifact preview" />
              </li>
            );
          })}
          {artifactPartition.earlier.length > 0 ? (
            <li>
              <details className="run-collapsible-history">
                <summary className="run-collapsible-history__summary">
                  {`Show ${artifactPartition.earlier.length} earlier artifacts`}
                </summary>
                <ul className="page-stack run-collapsible-history__list" aria-label="Earlier run artifacts">
                  {artifactPartition.earlier.map((artifact) => {
                    const node = detail.nodes.find((candidate) => candidate.id === artifact.runNodeId);
                    const nodeLabel = node ? node.nodeKey : `node-${artifact.runNodeId}`;
                    return (
                      <li key={`older-${artifact.id}`}>
                        <p>{`${nodeLabel} · ${artifact.artifactType} (${artifact.contentType})`}</p>
                        <ExpandablePreview value={artifact.contentPreview} label="artifact preview" />
                      </li>
                    );
                  })}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="run-observability-section">
        <p className="meta-text">Node diagnostics</p>
        {detail.diagnostics.length === 0 ? <p>No node diagnostics captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run node diagnostics">
          {diagnosticsPartition.recent.map((diagnostics) => renderDiagnosticsEntry(diagnostics))}
          {diagnosticsPartition.earlier.length > 0 ? (
            <li>
              <details className="run-collapsible-history">
                <summary className="run-collapsible-history__summary">
                  {`Show ${diagnosticsPartition.earlier.length} earlier diagnostics`}
                </summary>
                <ul className="page-stack run-collapsible-history__list" aria-label="Earlier run node diagnostics">
                  {diagnosticsPartition.earlier.map((diagnostics) => renderDiagnosticsEntry(diagnostics))}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="run-observability-section">
        <p className="meta-text">Routing decisions</p>
        {detail.routingDecisions.length === 0 ? <p>No routing decisions captured yet.</p> : null}
        <ul className="page-stack run-observability-list" aria-label="Run routing decisions">
          {detail.routingDecisions.map((decision) => (
            <li key={decision.id}>
              <p>{decision.decisionType}</p>
              <p className="meta-text">{decision.rationale ?? 'No rationale provided.'}</p>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

export function RunDetailContent({
  initialDetail,
  repositories,
  enableRealtime = true,
  pollIntervalMs = RUN_DETAIL_POLL_INTERVAL_MS,
}: RunDetailContentProps) {
  const [detail, setDetail] = useState<DashboardRunDetail>(initialDetail);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [channelState, setChannelState] = useState<RealtimeChannelState>(() =>
    enableRealtime && isActiveRunStatus(initialDetail.run.status) ? 'live' : 'disabled',
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<number | null>(null);
  const [filteredNodeId, setFilteredNodeId] = useState<number | null>(null);
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number>(() => resolveInitialLastUpdatedAtMs(initialDetail));
  const [nextRetryAtMs, setNextRetryAtMs] = useState<number | null>(null);
  const [retryCountdownSeconds, setRetryCountdownSeconds] = useState<number | null>(null);
  const [hasHydrated, setHasHydrated] = useState<boolean>(false);
  const [streamTarget, setStreamTarget] = useState<AgentStreamTarget | null>(() =>
    resolveInitialAgentStreamTarget(initialDetail),
  );
  const [streamEvents, setStreamEvents] = useState<DashboardRunNodeStreamEvent[]>([]);
  const [streamBufferedEvents, setStreamBufferedEvents] = useState<DashboardRunNodeStreamEvent[]>([]);
  const [streamConnectionState, setStreamConnectionState] = useState<AgentStreamConnectionState>('ended');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamNextRetryAtMs, setStreamNextRetryAtMs] = useState<number | null>(null);
  const [streamRetryCountdownSeconds, setStreamRetryCountdownSeconds] = useState<number | null>(null);
  const [streamAutoScroll, setStreamAutoScroll] = useState<boolean>(true);
  const [streamLastUpdatedAtMs, setStreamLastUpdatedAtMs] = useState<number>(() =>
    resolveInitialStreamLastUpdatedAtMs(initialDetail),
  );

  const lastUpdatedAtRef = useRef<number>(lastUpdatedAtMs);
  const streamLastUpdatedAtRef = useRef<number>(streamLastUpdatedAtMs);
  const streamLastSequenceRef = useRef<number>(0);
  const streamEventListRef = useRef<HTMLOListElement | null>(null);
  const streamAutoScrollRef = useRef<boolean>(streamAutoScroll);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    setDetail(initialDetail);
    setUpdateError(null);
    setIsRefreshing(false);
    setNextRetryAtMs(null);
    setRetryCountdownSeconds(null);
    setLastUpdatedAtMs(Date.now());
    setChannelState(enableRealtime && isActiveRunStatus(initialDetail.run.status) ? 'live' : 'disabled');
    setStreamTarget(resolveInitialAgentStreamTarget(initialDetail));
    setStreamEvents([]);
    setStreamBufferedEvents([]);
    setStreamConnectionState('ended');
    setStreamError(null);
    setStreamNextRetryAtMs(null);
    setStreamRetryCountdownSeconds(null);
    setStreamAutoScroll(true);
    setStreamLastUpdatedAtMs(Date.now());
    streamLastSequenceRef.current = 0;
  }, [enableRealtime, initialDetail]);

  useEffect(() => {
    lastUpdatedAtRef.current = lastUpdatedAtMs;
  }, [lastUpdatedAtMs]);

  useEffect(() => {
    streamLastUpdatedAtRef.current = streamLastUpdatedAtMs;
  }, [streamLastUpdatedAtMs]);

  useEffect(() => {
    streamAutoScrollRef.current = streamAutoScroll;
  }, [streamAutoScroll]);

  useEffect(() => {
    syncSelectionStateWithNodes({
      nodes: detail.nodes,
      highlightedNodeId,
      filteredNodeId,
      streamTarget,
      setHighlightedNodeId,
      setFilteredNodeId,
      setStreamTarget,
    });
  }, [detail.nodes, filteredNodeId, highlightedNodeId, streamTarget]);

  useEffect(() => {
    return createRunDetailPollingEffect({
      enableRealtime,
      runId: detail.run.id,
      runStatus: detail.run.status,
      pollIntervalMs,
      lastUpdatedAtRef,
      setChannelState,
      setIsRefreshing,
      setNextRetryAtMs,
      setUpdateError,
      setDetail,
      setLastUpdatedAtMs,
    });
  }, [detail.run.id, detail.run.status, enableRealtime, pollIntervalMs]);

  useEffect(() => {
    return createAgentStreamLifecycleEffect({
      runId: detail.run.id,
      streamTarget,
      streamAutoScrollRef,
      streamLastSequenceRef,
      streamLastUpdatedAtRef,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamConnectionState,
      setStreamError,
      setStreamNextRetryAtMs,
      setStreamRetryCountdownSeconds,
      setStreamLastUpdatedAtMs,
    });
  }, [detail.run.id, streamTarget]);

  useEffect(() => {
    if (!streamAutoScroll || streamBufferedEvents.length === 0) {
      return;
    }

    setStreamEvents(previous => mergeAgentStreamEvents(previous, streamBufferedEvents));
    setStreamBufferedEvents([]);
  }, [streamAutoScroll, streamBufferedEvents]);

  useEffect(() => {
    if (!streamAutoScroll || streamEventListRef.current === null) {
      return;
    }

    streamEventListRef.current.scrollTop = streamEventListRef.current.scrollHeight;
  }, [streamAutoScroll, streamEvents]);

  useEffect(() => {
    if (nextRetryAtMs === null) {
      setRetryCountdownSeconds(null);
      return;
    }

    const updateCountdown = (): void => {
      const remainingSeconds = Math.max(0, Math.ceil((nextRetryAtMs - Date.now()) / 1000));
      setRetryCountdownSeconds(remainingSeconds);
    };

    updateCountdown();
    const intervalId = globalThis.setInterval(updateCountdown, 250);

    return () => {
      clearInterval(intervalId);
    };
  }, [nextRetryAtMs]);

  useEffect(() => {
    if (streamNextRetryAtMs === null) {
      setStreamRetryCountdownSeconds(null);
      return;
    }

    const updateCountdown = (): void => {
      const remainingSeconds = Math.max(0, Math.ceil((streamNextRetryAtMs - Date.now()) / 1000));
      setStreamRetryCountdownSeconds(remainingSeconds);
    };

    updateCountdown();
    const intervalId = globalThis.setInterval(updateCountdown, 250);

    return () => {
      clearInterval(intervalId);
    };
  }, [streamNextRetryAtMs]);

  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const repositoryContext = useMemo(
    () => resolveRepositoryContext(detail, repositories),
    [detail, repositories],
  );
  const pageSubtitle = detail.run.repository
    ? `${detail.run.tree.name} · ${detail.run.repository.name}`
    : detail.run.tree.name;
  const primaryAction = useMemo(
    () => resolvePrimaryAction(detail.run, detail.worktrees.length > 0),
    [detail.run, detail.worktrees.length],
  );
  const selectedNode = useMemo(
    () => detail.nodes.find((node) => node.id === filteredNodeId) ?? null,
    [detail.nodes, filteredNodeId],
  );
  const visibleTimeline = useMemo(
    () =>
      filteredNodeId === null
        ? timeline
        : timeline.filter((event) => event.relatedNodeId === null || event.relatedNodeId === filteredNodeId),
    [filteredNodeId, timeline],
  );
  const latestTimelineEvent = timeline.at(-1) ?? null;
  const visibleTimelinePartition = useMemo(
    () => partitionByRecency(visibleTimeline, RUN_TIMELINE_RECENT_EVENT_COUNT),
    [visibleTimeline],
  );
  const realtimeLabel = resolveRealtimeLabel(channelState, pollIntervalMs, retryCountdownSeconds);
  const agentStreamLabel = resolveAgentStreamLabel(streamConnectionState, streamRetryCountdownSeconds);
  const selectedStreamNode = useMemo(
    () => (streamTarget ? detail.nodes.find(node => node.id === streamTarget.runNodeId) ?? null : null),
    [detail.nodes, streamTarget],
  );
  const toggleNodeFilter = (nodeId: number): void => {
    const nextNodeId = filteredNodeId === nodeId ? null : nodeId;
    setFilteredNodeId(nextNodeId);
    setHighlightedNodeId(nextNodeId);
  };

  const renderTimelineEvent = (event: TimelineItem) => {
    const highlighted = highlightedNodeId !== null && event.relatedNodeId === highlightedNodeId;

    return (
      <li key={event.key}>
        <button
          type="button"
          className={`run-timeline-event run-timeline-event--${event.category}${highlighted ? ' run-timeline-event--selected' : ''}`}
          aria-pressed={highlighted}
          onClick={() => {
            setHighlightedNodeId(event.relatedNodeId);
          }}
        >
          <span className="run-timeline-event__header">
            <span className={`timeline-category-indicator timeline-category-indicator--${event.category}`}>
              <TimelineCategoryIcon category={event.category} />
              <span>{TIMELINE_CATEGORY_LABELS[event.category]}</span>
            </span>
            <span className="meta-text">{formatTimelineTime(event.timestamp, hasHydrated)}</span>
          </span>
          <p>{event.summary}</p>
        </button>
      </li>
    );
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>{pageSubtitle}</p>
      </section>

      <div className="page-grid run-detail-priority-grid">
        <Card
          title="Operator focus"
          description="Current run status, latest event, and next likely operator action."
          className="run-operator-focus"
        >
          <ul className="entity-list run-operator-focus-list">
            <li>
              <span>Current status</span>
              <StatusBadge status={detail.run.status} />
            </li>
            <li>
              <span>Latest event</span>
              {latestTimelineEvent ? (
                <div className="run-operator-focus-list__value">
                  <p>{latestTimelineEvent.summary}</p>
                  <p className="meta-text">{formatTimelineTime(latestTimelineEvent.timestamp, hasHydrated)}</p>
                </div>
              ) : (
                <span className="meta-text">No lifecycle events captured yet.</span>
              )}
            </li>
            <li>
              <span>Next action</span>
              <span className="meta-text">{primaryAction.label}</span>
            </li>
          </ul>

          <div className="action-row run-detail-primary-actions">
            {primaryAction.href ? (
              <ButtonLink href={primaryAction.href} tone="primary">
                {primaryAction.label}
              </ButtonLink>
            ) : (
              <ActionButton tone="primary" disabled aria-disabled="true" title={primaryAction.disabledReason ?? undefined}>
                {primaryAction.label}
              </ActionButton>
            )}
            <ButtonLink href="/runs">Back to Runs</ButtonLink>
          </div>
          {primaryAction.disabledReason ? <p className="meta-text run-action-feedback">{primaryAction.disabledReason}</p> : null}

          <output className={`run-realtime-status run-realtime-status--${channelState}`} aria-live="polite">
            <span className="run-realtime-status__badge">{realtimeLabel.badgeLabel}</span>
            <span className="meta-text">{realtimeLabel.detail}</span>
            <span className="meta-text">
              {`Last updated ${formatLastUpdated(lastUpdatedAtMs, hasHydrated)}.`}
              {isRefreshing ? ' Refreshing timeline...' : ''}
            </span>
          </output>

          {updateError && (channelState === 'reconnecting' || channelState === 'stale') ? (
            <output className="run-realtime-warning" aria-live="polite">
              {`Update channel degraded: ${updateError}`}
            </output>
          ) : null}
        </Card>

        <Panel title="Run summary" description="Workflow context and timestamps." className="run-detail-summary-panel">
          <ul className="entity-list run-detail-summary-list">
            <li>
              <span>Workflow</span>
              <span className="meta-text">{`${detail.run.tree.name} (${detail.run.tree.treeKey})`}</span>
            </li>
            <li>
              <span>Repository context</span>
              <span className="meta-text">{repositoryContext}</span>
            </li>
            <li>
              <span>Worktrees</span>
              <span className="meta-text">{detail.worktrees.length}</span>
            </li>
            <li>
              <span>Started</span>
              <span className="meta-text">{formatDateTime(detail.run.startedAt, 'Not started', hasHydrated)}</span>
            </li>
            <li>
              <span>Completed</span>
              <span className="meta-text">{formatDateTime(detail.run.completedAt, 'In progress', hasHydrated)}</span>
            </li>
          </ul>
        </Panel>
      </div>

      <div className="page-grid run-detail-lifecycle-grid">
        <Card title="Timeline" description="Latest run events">
          {selectedNode ? (
            <div className="run-timeline-filter">
              <p className="meta-text">{`Filtered to ${selectedNode.nodeKey} (attempt ${selectedNode.attempt}).`}</p>
              <ActionButton
                className="run-timeline-clear"
                onClick={() => {
                  setFilteredNodeId(null);
                  setHighlightedNodeId(null);
                }}
              >
                Show all events
              </ActionButton>
            </div>
          ) : null}

          <ol className="page-stack run-timeline-list" aria-label="Run timeline">
            {visibleTimeline.length > 0 ? (
              <>
                {visibleTimelinePartition.earlier.length > 0 ? (
                  <li>
                    <details className="run-collapsible-history">
                      <summary className="run-collapsible-history__summary">
                        {`Show ${visibleTimelinePartition.earlier.length} earlier events`}
                      </summary>
                      <ol className="page-stack run-collapsible-history__list" aria-label="Earlier run timeline events">
                        {visibleTimelinePartition.earlier.map((event) => renderTimelineEvent(event))}
                      </ol>
                    </details>
                  </li>
                ) : null}
                {visibleTimelinePartition.recent.map((event) => renderTimelineEvent(event))}
              </>
            ) : (
              <li>
                <p>{filteredNodeId === null ? 'No lifecycle events captured yet.' : 'No events match the selected node.'}</p>
              </li>
            )}
          </ol>
        </Card>

        <Panel title="Node status" description="Node lifecycle snapshot">
          <ul className="entity-list run-node-status-list">
            {detail.nodes.length > 0 ? (
              detail.nodes.map((node) => {
                const selected = filteredNodeId === node.id;

                return (
                  <li key={node.id}>
                    <ActionButton
                      className={`run-node-filter${selected ? ' run-node-filter--selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        toggleNodeFilter(node.id);
                      }}
                    >
                      {`${node.nodeKey} (attempt ${node.attempt})`}
                    </ActionButton>
                    <StatusBadge status={node.status} />
                  </li>
                );
              })
            ) : (
              <li>
                <span>No run nodes have been materialized yet.</span>
              </li>
            )}
          </ul>
        </Panel>
      </div>

      <RunAgentStreamCard
        detail={detail}
        streamTarget={streamTarget}
        selectedStreamNode={selectedStreamNode}
        agentStreamLabel={agentStreamLabel}
        streamConnectionState={streamConnectionState}
        streamLastUpdatedAtMs={streamLastUpdatedAtMs}
        hasHydrated={hasHydrated}
        streamAutoScroll={streamAutoScroll}
        streamBufferedEvents={streamBufferedEvents}
        streamError={streamError}
        streamEvents={streamEvents}
        streamEventListRef={streamEventListRef}
        setStreamTarget={setStreamTarget}
        setStreamAutoScroll={setStreamAutoScroll}
        setStreamBufferedEvents={setStreamBufferedEvents}
        setStreamEvents={setStreamEvents}
      />

      <RunObservabilityCard detail={detail} />
    </div>
  );
}
