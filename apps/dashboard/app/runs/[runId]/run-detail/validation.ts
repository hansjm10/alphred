import type { DashboardRunDetail, DashboardRunNodeStreamEvent, DashboardRunNodeStreamSnapshot, DashboardRunSummary } from '../../../../src/server/dashboard-contracts';
import {
  ARTIFACT_CONTENT_TYPES,
  ARTIFACT_TYPES,
  DIAGNOSTIC_ERROR_CLASSIFICATIONS,
  DIAGNOSTIC_EVENT_TYPES,
  DIAGNOSTIC_OUTCOMES,
  DIAGNOSTIC_TOOL_EVENT_TYPES,
  NODE_STATUSES,
  ROUTING_DECISION_TYPES,
  RUN_STATUSES,
  STREAM_EVENT_TYPES,
  WORKTREE_STATUSES,
} from './types';
import type { DiagnosticErrorClassification } from './types';

const NODE_ROLES = new Set<DashboardRunDetail['nodes'][number]['nodeRole']>(['standard', 'spawner', 'join']);
const FAN_OUT_GROUP_STATUSES = new Set<DashboardRunDetail['fanOutGroups'][number]['status']>([
  'pending',
  'ready',
  'released',
  'cancelled',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function hasNodeStatusSummary(value: unknown): boolean {
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

export function hasArtifactShape(value: unknown): value is DashboardRunDetail['artifacts'][number] {
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

export function hasRoutingDecisionShape(value: unknown): value is DashboardRunDetail['routingDecisions'][number] {
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

export function hasDiagnosticsShape(value: unknown): value is DashboardRunDetail['diagnostics'][number] {
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
    !(payload.summary.inputTokens === null || isInteger(payload.summary.inputTokens)) ||
    !(payload.summary.outputTokens === null || isInteger(payload.summary.outputTokens)) ||
    !(payload.summary.cachedInputTokens === null || isInteger(payload.summary.cachedInputTokens)) ||
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

export function hasFanOutGroupShape(value: unknown): value is DashboardRunDetail['fanOutGroups'][number] {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isInteger(value.spawnerNodeId) ||
    !isInteger(value.joinNodeId) ||
    !isInteger(value.spawnSourceArtifactId) ||
    !isInteger(value.expectedChildren) ||
    !isInteger(value.terminalChildren) ||
    !isInteger(value.completedChildren) ||
    !isInteger(value.failedChildren) ||
    value.expectedChildren < 0 ||
    value.terminalChildren < 0 ||
    value.completedChildren < 0 ||
    value.failedChildren < 0 ||
    typeof value.status !== 'string' ||
    !FAN_OUT_GROUP_STATUSES.has(value.status as DashboardRunDetail['fanOutGroups'][number]['status']) ||
    !Array.isArray(value.childNodeIds) ||
    !value.childNodeIds.every(isInteger)
  ) {
    return false;
  }

  const uniqueChildNodeIds = new Set<number>(value.childNodeIds);
  if (uniqueChildNodeIds.size !== value.childNodeIds.length) {
    return false;
  }

  if (
    value.terminalChildren > value.expectedChildren ||
    value.completedChildren > value.terminalChildren ||
    value.failedChildren > value.terminalChildren ||
    value.completedChildren + value.failedChildren > value.terminalChildren ||
    value.childNodeIds.length > value.expectedChildren
  ) {
    return false;
  }

  return true;
}

function hasRunNodeBaseFields(value: Record<string, unknown>): boolean {
  return (
    isInteger(value.id) &&
    isInteger(value.treeNodeId) &&
    typeof value.nodeKey === 'string' &&
    typeof value.nodeRole === 'string' &&
    NODE_ROLES.has(value.nodeRole as DashboardRunDetail['nodes'][number]['nodeRole']) &&
    (value.spawnerNodeId === null || isInteger(value.spawnerNodeId)) &&
    (value.joinNodeId === null || isInteger(value.joinNodeId)) &&
    isInteger(value.lineageDepth) &&
    value.lineageDepth >= 0 &&
    isNullableString(value.sequencePath) &&
    isInteger(value.sequenceIndex) &&
    isInteger(value.attempt) &&
    typeof value.status === 'string' &&
    NODE_STATUSES.has(value.status as DashboardRunDetail['nodes'][number]['status']) &&
    isNullableString(value.startedAt) &&
    isNullableString(value.completedAt)
  );
}

function hasRunNodeRoleConsistency(value: Record<string, unknown>): boolean {
  const nodeRole = value.nodeRole as DashboardRunDetail['nodes'][number]['nodeRole'];
  const lineageDepth = value.lineageDepth as number;
  const hasSpawnerNodeId = value.spawnerNodeId !== null;
  const hasJoinNodeId = value.joinNodeId !== null;
  if (hasSpawnerNodeId !== hasJoinNodeId) {
    return false;
  }

  if ((nodeRole === 'spawner' || nodeRole === 'join') && (hasSpawnerNodeId || hasJoinNodeId)) {
    return false;
  }

  if ((nodeRole === 'spawner' || nodeRole === 'join') && lineageDepth !== 0) {
    return false;
  }

  if (nodeRole === 'standard' && hasSpawnerNodeId && lineageDepth < 1) {
    return false;
  }

  if (nodeRole === 'standard' && !hasSpawnerNodeId && lineageDepth !== 0) {
    return false;
  }

  if (nodeRole === 'standard' && hasSpawnerNodeId && typeof value.sequencePath !== 'string') {
    return false;
  }

  return true;
}

function hasRunNodeRelatedShapes(value: Record<string, unknown>): boolean {
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

export function hasRunNodeShape(value: unknown): value is DashboardRunDetail['nodes'][number] {
  if (!isRecord(value)) {
    return false;
  }

  if (!hasRunNodeBaseFields(value)) {
    return false;
  }

  if (!hasRunNodeRoleConsistency(value)) {
    return false;
  }

  return hasRunNodeRelatedShapes(value);
}

export function hasWorktreeShape(
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

export function hasStreamEventShape(
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

export function hasRunNodeStreamSnapshotShape(
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

export function hasRunSummaryShape(value: unknown, expectedRunId: number): value is DashboardRunDetail['run'] {
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
