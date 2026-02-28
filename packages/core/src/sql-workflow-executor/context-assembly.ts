import type { AlphredDatabase } from '@alphred/db';
import {
  MAX_ERROR_SUMMARY_CHARS,
  CONTEXT_POLICY_VERSION,
  JOIN_SUMMARY_RESERVED_CHARS,
  MAX_CHARS_PER_ARTIFACT,
  MAX_CONTEXT_CHARS_TOTAL,
  MAX_FAILURE_ROUTE_CONTEXT_CHARS,
  MAX_RETRY_SUMMARY_CONTEXT_CHARS,
  MAX_UPSTREAM_ARTIFACTS,
  MIN_REMAINING_CONTEXT_CHARS,
} from './constants.js';
import {
  buildRoutingSelection,
  loadLatestFailureArtifact,
  loadRetryFailureSummaryArtifact,
  loadUpstreamArtifactSelectionByRunNodeId,
} from './routing-selection.js';
import { loadBarriersForSpawnerJoin, loadMostRecentJoinBarrier, loadReadyJoinBarriersForJoinNode } from './fanout.js';
import {
  buildTruncationMetadata,
  compareUpstreamSourceOrder,
  hashContentSha256,
  serializeFailureRouteContextEnvelope,
  serializeRetryFailureSummaryEnvelope,
  serializeContextEnvelope,
  truncateHeadTail,
} from './type-conversions.js';
import type {
  AssembledUpstreamContext,
  ContextEnvelopeCandidate,
  ContextEnvelopeEntry,
  ContextHandoffManifest,
  EdgeRow,
  FailureLogArtifact,
  LatestArtifact,
  RetryFailureSummaryArtifact,
  RoutingDecisionRow,
  RunNodeExecutionRow,
  UpstreamReportArtifact,
} from './types.js';

const terminalSourceStatuses = new Set(['completed', 'failed', 'skipped', 'cancelled']);

export function selectDirectPredecessorNodes(
  targetNode: RunNodeExecutionRow,
  latestNodeAttempts: RunNodeExecutionRow[],
  edgeRows: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
  joinBatchChildRunNodeIds: ReadonlySet<number> | null = null,
): RunNodeExecutionRow[] {
  const routingSelection = buildRoutingSelection(
    latestNodeAttempts,
    edgeRows,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );
  const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(targetNode.runNodeId) ?? [];
  const allowTerminalIncoming = targetNode.nodeRole === 'join';

  const predecessors: RunNodeExecutionRow[] = [];
  const seenSourceNodeIds = new Set<number>();
  for (const edge of incomingEdges) {
    if (edge.routeOn !== 'success' && (!allowTerminalIncoming || edge.routeOn !== 'terminal')) {
      continue;
    }

    if (
      edge.routeOn === 'success' &&
      routingSelection.selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId
    ) {
      continue;
    }

    if (seenSourceNodeIds.has(edge.sourceNodeId)) {
      continue;
    }

    const sourceNode = routingSelection.latestByTreeNodeId.get(edge.sourceNodeId);
    if (!sourceNode) {
      continue;
    }

    if (edge.routeOn === 'success' && sourceNode.status !== 'completed') {
      continue;
    }

    if (edge.routeOn === 'terminal' && !terminalSourceStatuses.has(sourceNode.status)) {
      continue;
    }

    if (
      targetNode.nodeRole === 'join' &&
      edge.routeOn === 'terminal' &&
      edge.edgeKind === 'dynamic_child_to_join' &&
      joinBatchChildRunNodeIds !== null &&
      !joinBatchChildRunNodeIds.has(sourceNode.runNodeId)
    ) {
      continue;
    }

    seenSourceNodeIds.add(edge.sourceNodeId);
    predecessors.push(sourceNode);
  }

  return predecessors.sort(compareUpstreamSourceOrder);
}

function resolveJoinBatchChildRunNodeIds(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    targetNode: RunNodeExecutionRow;
    latestNodeAttempts: RunNodeExecutionRow[];
  },
): Set<number> | null {
  if (params.targetNode.nodeRole !== 'join') {
    return null;
  }

  const joinRunNodeId = params.targetNode.runNodeId;
  const readyBarriers = loadReadyJoinBarriersForJoinNode(db, {
    workflowRunId: params.workflowRunId,
    joinRunNodeId,
  });
  if (readyBarriers.length === 0) {
    const mostRecentBarrier = loadMostRecentJoinBarrier(db, {
      workflowRunId: params.workflowRunId,
      joinRunNodeId,
    });
    return mostRecentBarrier ? new Set<number>() : null;
  }

  const latestChildrenBySpawnerRunNodeId = new Map<number, RunNodeExecutionRow[]>();
  for (const node of params.latestNodeAttempts) {
    if (node.spawnerNodeId === null || node.joinNodeId !== joinRunNodeId) {
      continue;
    }

    const children = latestChildrenBySpawnerRunNodeId.get(node.spawnerNodeId);
    if (children) {
      children.push(node);
      continue;
    }

    latestChildrenBySpawnerRunNodeId.set(node.spawnerNodeId, [node]);
  }
  for (const children of latestChildrenBySpawnerRunNodeId.values()) {
    children.sort((left, right) => {
      if (left.sequenceIndex !== right.sequenceIndex) {
        return right.sequenceIndex - left.sequenceIndex;
      }
      return right.runNodeId - left.runNodeId;
    });
  }

  const batchOffsetByBarrierId = new Map<number, number>();
  const resolvedSpawnerRunNodeIds = new Set<number>();
  const batchChildRunNodeIds = new Set<number>();
  for (const barrier of readyBarriers) {
    if (!resolvedSpawnerRunNodeIds.has(barrier.spawnerRunNodeId)) {
      const barriersForSpawnerJoin = loadBarriersForSpawnerJoin(db, {
        workflowRunId: params.workflowRunId,
        spawnerRunNodeId: barrier.spawnerRunNodeId,
        joinRunNodeId,
      });
      let consumedChildren = 0;
      for (let index = barriersForSpawnerJoin.length - 1; index >= 0; index -= 1) {
        const spawnerJoinBarrier = barriersForSpawnerJoin[index];
        batchOffsetByBarrierId.set(spawnerJoinBarrier.id, consumedChildren);
        consumedChildren += spawnerJoinBarrier.expectedChildren;
      }
      resolvedSpawnerRunNodeIds.add(barrier.spawnerRunNodeId);
    }

    const childrenForSpawner = latestChildrenBySpawnerRunNodeId.get(barrier.spawnerRunNodeId) ?? [];
    const batchOffset = batchOffsetByBarrierId.get(barrier.id) ?? 0;
    const batchChildren = childrenForSpawner.slice(batchOffset, batchOffset + barrier.expectedChildren);

    for (const childNode of batchChildren) {
      batchChildRunNodeIds.add(childNode.runNodeId);
    }
  }

  return batchChildRunNodeIds;
}

export function resolveIncludedContentForContextCandidate(
  candidate: ContextEnvelopeCandidate,
  remainingChars: number,
): {
  includedContent: string | null;
  budgetOverflow: boolean;
} {
  if (remainingChars <= 0) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  let includedContent = truncateHeadTail(candidate.originalContent, MAX_CHARS_PER_ARTIFACT);
  if (includedContent.length <= remainingChars) {
    return {
      includedContent,
      budgetOverflow: false,
    };
  }

  if (remainingChars < MIN_REMAINING_CONTEXT_CHARS) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  includedContent = truncateHeadTail(candidate.originalContent, Math.min(MAX_CHARS_PER_ARTIFACT, remainingChars));
  if (includedContent.length <= 0) {
    return {
      includedContent: null,
      budgetOverflow: true,
    };
  }

  return {
    includedContent,
    budgetOverflow: true,
  };
}

function selectFailureRouteSourceNode(params: {
  targetNode: RunNodeExecutionRow;
  incomingEdges: EdgeRow[];
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>;
  selectedEdgeIdBySourceNodeId: Map<number, number>;
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>;
}): RunNodeExecutionRow | null {
  const targetArtifactId =
    params.latestArtifactsByRunNodeId.get(params.targetNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;

  const selectedFailureSources: {
    sourceNode: RunNodeExecutionRow;
    latestArtifactId: number;
  }[] = [];
  for (const edge of params.incomingEdges) {
    if (edge.routeOn !== 'failure') {
      continue;
    }

    if (params.selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      continue;
    }

    const sourceNode = params.latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'failed') {
      continue;
    }

    const latestArtifactId = params.latestArtifactsByRunNodeId.get(sourceNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;
    selectedFailureSources.push({
      sourceNode,
      latestArtifactId,
    });
  }

  if (selectedFailureSources.length === 0) {
    return null;
  }

  const triggeringSources = selectedFailureSources.filter(candidate => candidate.latestArtifactId > targetArtifactId);
  if (triggeringSources.length === 0) {
    return null;
  }

  triggeringSources.sort((a, b) => {
    if (a.latestArtifactId !== b.latestArtifactId) {
      return a.latestArtifactId > b.latestArtifactId ? -1 : 1;
    }

    return compareUpstreamSourceOrder(a.sourceNode, b.sourceNode);
  });

  return triggeringSources[0]?.sourceNode ?? null;
}

type FailureRouteContextEntry = {
  entry: string;
  sourceNodeKey: string;
  sourceRunNodeId: number;
  failureArtifactId: number;
  retrySummaryArtifactId: number | null;
  includedChars: number;
  truncated: boolean;
};

type RetrySummaryContextEntry = {
  entry: string;
  artifactId: number;
  sourceAttempt: number;
  targetAttempt: number;
  includedChars: number;
  truncated: boolean;
};

type IncludedContextCandidates = {
  includedEntries: ContextEnvelopeEntry[];
  droppedArtifactIds: number[];
  budgetOverflow: boolean;
};

function collectContextEnvelopeCandidates(
  directPredecessors: RunNodeExecutionRow[],
  latestReportsByRunNodeId: Map<number, UpstreamReportArtifact>,
): ContextEnvelopeCandidate[] {
  const candidateEntries: ContextEnvelopeCandidate[] = [];
  for (const sourceNode of directPredecessors) {
    const artifact = latestReportsByRunNodeId.get(sourceNode.runNodeId);
    if (!artifact) {
      continue;
    }

    candidateEntries.push({
      artifactId: artifact.id,
      sourceNodeKey: sourceNode.nodeKey,
      sourceRunNodeId: sourceNode.runNodeId,
      sourceAttempt: sourceNode.attempt,
      contentType: artifact.contentType,
      createdAt: artifact.createdAt,
      originalContent: artifact.content,
      sha256: hashContentSha256(artifact.content),
    });
  }

  return candidateEntries;
}

function prioritizeJoinCandidateEntries(
  targetNode: RunNodeExecutionRow,
  directPredecessors: RunNodeExecutionRow[],
  candidateEntries: ContextEnvelopeCandidate[],
): ContextEnvelopeCandidate[] {
  if (targetNode.nodeRole !== 'join') {
    return candidateEntries;
  }

  const statusByRunNodeId = new Map<number, RunNodeExecutionRow['status']>(
    directPredecessors.map(node => [node.runNodeId, node.status]),
  );
  return [...candidateEntries].sort((left, right) => {
    const leftFailed = statusByRunNodeId.get(left.sourceRunNodeId) === 'failed' ? 0 : 1;
    const rightFailed = statusByRunNodeId.get(right.sourceRunNodeId) === 'failed' ? 0 : 1;
    if (leftFailed !== rightFailed) {
      return leftFailed - rightFailed;
    }

    if (left.createdAt !== right.createdAt) {
      return left.createdAt > right.createdAt ? -1 : 1;
    }

    return left.sourceRunNodeId - right.sourceRunNodeId;
  });
}

type JoinSummaryContextEntry = {
  entry: string;
  includedChars: number;
};

function buildJoinSummaryContextEntry(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    targetNode: RunNodeExecutionRow;
    directPredecessors: RunNodeExecutionRow[];
    latestReportsByRunNodeId: Map<number, UpstreamReportArtifact>;
  },
): JoinSummaryContextEntry | null {
  if (params.targetNode.nodeRole !== 'join') {
    return null;
  }

  const readyBarriers = loadReadyJoinBarriersForJoinNode(db, {
    workflowRunId: params.workflowRunId,
    joinRunNodeId: params.targetNode.runNodeId,
  });
  const summaryBarriers =
    readyBarriers.length > 0
      ? readyBarriers
      : (() => {
          const mostRecentBarrier = loadMostRecentJoinBarrier(db, {
            workflowRunId: params.workflowRunId,
            joinRunNodeId: params.targetNode.runNodeId,
          });
          return mostRecentBarrier ? [mostRecentBarrier] : [];
        })();
  if (summaryBarriers.length === 0) {
    return null;
  }

  let totalExpectedChildren = 0;
  let totalTerminalChildren = 0;
  let totalCompletedChildren = 0;
  let totalFailedChildren = 0;
  const spawnerRunNodeIds = new Set<number>();
  for (const barrier of summaryBarriers) {
    spawnerRunNodeIds.add(barrier.spawnerRunNodeId);
    totalExpectedChildren += barrier.expectedChildren;
    totalTerminalChildren += barrier.terminalChildren;
    totalCompletedChildren += barrier.completedChildren;
    totalFailedChildren += barrier.failedChildren;
  }
  const sortedSpawnerRunNodeIds = [...spawnerRunNodeIds].sort((left, right) => left - right);
  const primarySpawnerRunNodeId = Math.min(...sortedSpawnerRunNodeIds);

  const lines: string[] = [
    'ALPHRED_JOIN_SUBTASKS v1',
    `join_run_node_id: ${params.targetNode.runNodeId}`,
    `spawner_run_node_id: ${primarySpawnerRunNodeId}`,
    `spawner_run_node_ids: ${sortedSpawnerRunNodeIds.join(',')}`,
    `subtasks.total: ${totalExpectedChildren}`,
    `subtasks.terminal: ${totalTerminalChildren}`,
    `subtasks.succeeded: ${totalCompletedChildren}`,
    `subtasks.failed: ${totalFailedChildren}`,
    'subtask_rows:',
  ];

  const sortedPredecessors = [...params.directPredecessors].sort(compareUpstreamSourceOrder);
  for (const sourceNode of sortedPredecessors) {
    const reportArtifact = params.latestReportsByRunNodeId.get(sourceNode.runNodeId) ?? null;
    const failureArtifact =
      sourceNode.status === 'failed'
        ? loadLatestFailureArtifact(db, {
            workflowRunId: params.workflowRunId,
            runNodeId: sourceNode.runNodeId,
          })
        : null;
    const previewSource = failureArtifact?.content ?? reportArtifact?.content ?? '';
    const preview = previewSource.length === 0 ? 'none' : truncateHeadTail(previewSource, 160).replace(/\s+/g, ' ');
    const artifactId = failureArtifact?.id ?? reportArtifact?.id ?? null;
    lines.push(
      `- node_key: ${sourceNode.nodeKey}; run_node_id: ${sourceNode.runNodeId}; status: ${sourceNode.status}; artifact_id: ${artifactId === null ? 'null' : artifactId}; preview: ${preview}`,
    );
  }

  const rawSummary = lines.join('\n');
  const includedSummary = truncateHeadTail(rawSummary, JOIN_SUMMARY_RESERVED_CHARS);
  return {
    entry: includedSummary,
    includedChars: includedSummary.length,
  };
}

function loadFailureRouteArtifacts(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    sourceNode: RunNodeExecutionRow | null;
  },
): {
  failureArtifact: FailureLogArtifact | null;
  retrySummaryArtifact: RetryFailureSummaryArtifact | null;
} {
  const { sourceNode, workflowRunId } = params;
  if (!sourceNode) {
    return {
      failureArtifact: null,
      retrySummaryArtifact: null,
    };
  }

  const failureArtifact = loadLatestFailureArtifact(db, {
    workflowRunId,
    runNodeId: sourceNode.runNodeId,
  });
  let retrySummaryArtifact: RetryFailureSummaryArtifact | null = null;
  if (sourceNode.attempt > 1) {
    retrySummaryArtifact = loadRetryFailureSummaryArtifact(db, {
      workflowRunId,
      runNodeId: sourceNode.runNodeId,
      sourceAttempt: sourceNode.attempt - 1,
      targetAttempt: sourceNode.attempt,
    });
  }

  return {
    failureArtifact,
    retrySummaryArtifact,
  };
}

function resolveFailureRouteFailureReason(
  sourceNode: RunNodeExecutionRow,
  failureArtifact: FailureLogArtifact,
): string {
  const metadataFailureReason = failureArtifact.metadata?.failureReason;
  if (typeof metadataFailureReason === 'string') {
    return metadataFailureReason;
  }

  if (sourceNode.attempt > sourceNode.maxRetries) {
    return 'retry_limit_exceeded';
  }

  return 'failure';
}

function buildFailureRouteRawPayload(params: {
  sourceNode: RunNodeExecutionRow;
  failureArtifact: FailureLogArtifact;
  retrySummaryArtifact: RetryFailureSummaryArtifact | null;
}): string {
  const { failureArtifact, retrySummaryArtifact, sourceNode } = params;
  const failureReason = resolveFailureRouteFailureReason(sourceNode, failureArtifact);
  const retriesExhausted = sourceNode.attempt > sourceNode.maxRetries;
  let rawPayload = [
    'attempt_metadata:',
    `  attempt: ${sourceNode.attempt}`,
    `  max_retries: ${sourceNode.maxRetries}`,
    `  retries_exhausted: ${retriesExhausted ? 'true' : 'false'}`,
    `  retries_used: ${Math.max(sourceNode.attempt - 1, 0)}`,
    `  failure_reason: ${failureReason}`,
    'failure_artifact:',
    `  id: ${failureArtifact.id}`,
    `  created_at: ${failureArtifact.createdAt}`,
    '  content:',
    failureArtifact.content,
  ].join('\n');

  if (!retrySummaryArtifact) {
    return rawPayload;
  }

  const failureArtifactId =
    retrySummaryArtifact.failureArtifactId === null ? 'null' : String(retrySummaryArtifact.failureArtifactId);
  rawPayload = `${rawPayload}\nretry_summary_artifact:\n  id: ${retrySummaryArtifact.id}\n  source_attempt: ${retrySummaryArtifact.sourceAttempt}\n  target_attempt: ${retrySummaryArtifact.targetAttempt}\n  failure_artifact_id: ${failureArtifactId}\n  created_at: ${retrySummaryArtifact.createdAt}\n  content:\n${retrySummaryArtifact.content}`;
  return rawPayload;
}

function createFailureRouteContextEntry(params: {
  workflowRunId: number;
  targetNode: RunNodeExecutionRow;
  sourceNode: RunNodeExecutionRow | null;
  failureArtifact: FailureLogArtifact | null;
  retrySummaryArtifact: RetryFailureSummaryArtifact | null;
}): FailureRouteContextEntry | null {
  const { failureArtifact, retrySummaryArtifact, sourceNode, targetNode, workflowRunId } = params;
  if (!sourceNode || !failureArtifact) {
    return null;
  }

  const rawPayload = buildFailureRouteRawPayload({
    sourceNode,
    failureArtifact,
    retrySummaryArtifact,
  });
  const includedContent = truncateHeadTail(rawPayload, MAX_FAILURE_ROUTE_CONTEXT_CHARS);
  const truncation = buildTruncationMetadata(rawPayload.length, includedContent.length);

  return {
    entry: serializeFailureRouteContextEnvelope({
      workflowRunId,
      targetNodeKey: targetNode.nodeKey,
      sourceNodeKey: sourceNode.nodeKey,
      sourceRunNodeId: sourceNode.runNodeId,
      sourceAttempt: sourceNode.attempt,
      failureArtifactId: failureArtifact.id,
      retrySummaryArtifactId: retrySummaryArtifact?.id ?? null,
      createdAt: failureArtifact.createdAt,
      includedContent,
      truncation,
    }),
    sourceNodeKey: sourceNode.nodeKey,
    sourceRunNodeId: sourceNode.runNodeId,
    failureArtifactId: failureArtifact.id,
    retrySummaryArtifactId: retrySummaryArtifact?.id ?? null,
    includedChars: truncation.includedChars,
    truncated: truncation.applied,
  };
}

function loadRetrySummaryContextEntry(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    targetNode: RunNodeExecutionRow;
    targetAttempt: number;
  },
): RetrySummaryContextEntry | null {
  const { targetAttempt, targetNode, workflowRunId } = params;
  if (targetAttempt <= 1) {
    return null;
  }

  const retrySummaryCandidate = loadRetryFailureSummaryArtifact(db, {
    workflowRunId,
    runNodeId: targetNode.runNodeId,
    sourceAttempt: targetAttempt - 1,
    targetAttempt,
  });
  if (!retrySummaryCandidate) {
    return null;
  }

  const summaryCharLimit = Math.min(MAX_ERROR_SUMMARY_CHARS, MAX_RETRY_SUMMARY_CONTEXT_CHARS);
  const includedSummaryContent = truncateHeadTail(retrySummaryCandidate.content, summaryCharLimit);
  const truncation = buildTruncationMetadata(retrySummaryCandidate.content.length, includedSummaryContent.length);
  return {
    entry: serializeRetryFailureSummaryEnvelope({
      workflowRunId,
      targetNodeKey: targetNode.nodeKey,
      sourceAttempt: retrySummaryCandidate.sourceAttempt,
      targetAttempt: retrySummaryCandidate.targetAttempt,
      summaryArtifactId: retrySummaryCandidate.id,
      failureArtifactId: retrySummaryCandidate.failureArtifactId,
      createdAt: retrySummaryCandidate.createdAt,
      includedContent: includedSummaryContent,
      sha256: hashContentSha256(retrySummaryCandidate.content),
      truncation,
    }),
    artifactId: retrySummaryCandidate.id,
    sourceAttempt: retrySummaryCandidate.sourceAttempt,
    targetAttempt: retrySummaryCandidate.targetAttempt,
    includedChars: truncation.includedChars,
    truncated: truncation.applied,
  };
}

function includeContextCandidates(
  candidateEntries: ContextEnvelopeCandidate[],
  reservedChars: number,
): IncludedContextCandidates {
  const includedEntries: ContextEnvelopeEntry[] = [];
  const droppedArtifactIds: number[] = [];
  let remainingChars = Math.max(MAX_CONTEXT_CHARS_TOTAL - reservedChars, 0);
  let budgetOverflow = false;

  for (const candidate of candidateEntries) {
    if (includedEntries.length >= MAX_UPSTREAM_ARTIFACTS) {
      budgetOverflow = true;
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    const inclusion = resolveIncludedContentForContextCandidate(candidate, remainingChars);
    if (inclusion.budgetOverflow) {
      budgetOverflow = true;
    }
    if (!inclusion.includedContent) {
      droppedArtifactIds.push(candidate.artifactId);
      continue;
    }

    const truncation = buildTruncationMetadata(candidate.originalContent.length, inclusion.includedContent.length);
    includedEntries.push({
      ...candidate,
      includedContent: inclusion.includedContent,
      truncation,
    });
    remainingChars -= inclusion.includedContent.length;
  }

  return {
    includedEntries,
    droppedArtifactIds,
    budgetOverflow,
  };
}

function buildContextEntries(params: {
  workflowRunId: number;
  targetNodeKey: string;
  failureRouteContextEntry: FailureRouteContextEntry | null;
  joinSummaryEntry: JoinSummaryContextEntry | null;
  includedEntries: ContextEnvelopeEntry[];
  retrySummaryEntry: RetrySummaryContextEntry | null;
}): string[] {
  const { failureRouteContextEntry, includedEntries, joinSummaryEntry, retrySummaryEntry, targetNodeKey, workflowRunId } =
    params;
  const contextEntries: string[] = [];
  if (failureRouteContextEntry) {
    contextEntries.push(failureRouteContextEntry.entry);
  }
  if (joinSummaryEntry) {
    contextEntries.push(joinSummaryEntry.entry);
  }
  contextEntries.push(
    ...includedEntries.map(entry =>
      serializeContextEnvelope({
        workflowRunId,
        targetNodeKey,
        entry,
      }),
    ),
  );
  if (retrySummaryEntry) {
    contextEntries.push(retrySummaryEntry.entry);
  }

  return contextEntries;
}

function buildFailureRouteManifestFields(
  failureRouteContextEntry: FailureRouteContextEntry | null,
): Pick<
  ContextHandoffManifest,
  | 'failure_route_context_included'
  | 'failure_route_source_node_key'
  | 'failure_route_source_run_node_id'
  | 'failure_route_failure_artifact_id'
  | 'failure_route_retry_summary_artifact_id'
  | 'failure_route_context_chars'
  | 'failure_route_context_truncated'
> {
  if (!failureRouteContextEntry) {
    return {
      failure_route_context_included: false,
      failure_route_source_node_key: null,
      failure_route_source_run_node_id: null,
      failure_route_failure_artifact_id: null,
      failure_route_retry_summary_artifact_id: null,
      failure_route_context_chars: 0,
      failure_route_context_truncated: false,
    };
  }

  return {
    failure_route_context_included: true,
    failure_route_source_node_key: failureRouteContextEntry.sourceNodeKey,
    failure_route_source_run_node_id: failureRouteContextEntry.sourceRunNodeId,
    failure_route_failure_artifact_id: failureRouteContextEntry.failureArtifactId,
    failure_route_retry_summary_artifact_id: failureRouteContextEntry.retrySummaryArtifactId,
    failure_route_context_chars: failureRouteContextEntry.includedChars,
    failure_route_context_truncated: failureRouteContextEntry.truncated,
  };
}

function buildRetrySummaryManifestFields(
  retrySummaryEntry: RetrySummaryContextEntry | null,
): Pick<
  ContextHandoffManifest,
  | 'retry_summary_included'
  | 'retry_summary_artifact_id'
  | 'retry_summary_source_attempt'
  | 'retry_summary_target_attempt'
  | 'retry_summary_chars'
  | 'retry_summary_truncated'
> {
  if (!retrySummaryEntry) {
    return {
      retry_summary_included: false,
      retry_summary_artifact_id: null,
      retry_summary_source_attempt: null,
      retry_summary_target_attempt: null,
      retry_summary_chars: 0,
      retry_summary_truncated: false,
    };
  }

  return {
    retry_summary_included: true,
    retry_summary_artifact_id: retrySummaryEntry.artifactId,
    retry_summary_source_attempt: retrySummaryEntry.sourceAttempt,
    retry_summary_target_attempt: retrySummaryEntry.targetAttempt,
    retry_summary_chars: retrySummaryEntry.includedChars,
    retry_summary_truncated: retrySummaryEntry.truncated,
  };
}

export function assembleUpstreamArtifactContext(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    targetNode: RunNodeExecutionRow;
    targetAttempt: number;
    latestNodeAttempts: RunNodeExecutionRow[];
    edgeRows: EdgeRow[];
    latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>;
    latestArtifactsByRunNodeId: Map<number, LatestArtifact>;
  },
): AssembledUpstreamContext {
  const joinBatchChildRunNodeIds = resolveJoinBatchChildRunNodeIds(db, {
    workflowRunId: params.workflowRunId,
    targetNode: params.targetNode,
    latestNodeAttempts: params.latestNodeAttempts,
  });
  const directPredecessors = selectDirectPredecessorNodes(
    params.targetNode,
    params.latestNodeAttempts,
    params.edgeRows,
    params.latestRoutingDecisionsByRunNodeId,
    params.latestArtifactsByRunNodeId,
    joinBatchChildRunNodeIds,
  );
  const predecessorRunNodeIds = directPredecessors.map(node => node.runNodeId);
  const artifactSelection = loadUpstreamArtifactSelectionByRunNodeId(db, params.workflowRunId, predecessorRunNodeIds);
  const candidateEntries = prioritizeJoinCandidateEntries(
    params.targetNode,
    directPredecessors,
    collectContextEnvelopeCandidates(directPredecessors, artifactSelection.latestReportsByRunNodeId),
  );

  const routingSelection = buildRoutingSelection(
    params.latestNodeAttempts,
    params.edgeRows,
    params.latestRoutingDecisionsByRunNodeId,
    params.latestArtifactsByRunNodeId,
  );
  const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(params.targetNode.runNodeId) ?? [];
  const failureRouteSourceNode = selectFailureRouteSourceNode({
    targetNode: params.targetNode,
    incomingEdges,
    latestByTreeNodeId: routingSelection.latestByTreeNodeId,
    selectedEdgeIdBySourceNodeId: routingSelection.selectedEdgeIdBySourceNodeId,
    latestArtifactsByRunNodeId: params.latestArtifactsByRunNodeId,
  });
  const failureRouteArtifacts = loadFailureRouteArtifacts(db, {
    workflowRunId: params.workflowRunId,
    sourceNode: failureRouteSourceNode,
  });
  const failureRouteContextEntry = createFailureRouteContextEntry({
    workflowRunId: params.workflowRunId,
    targetNode: params.targetNode,
    sourceNode: failureRouteSourceNode,
    failureArtifact: failureRouteArtifacts.failureArtifact,
    retrySummaryArtifact: failureRouteArtifacts.retrySummaryArtifact,
  });
  const retrySummaryEntry = loadRetrySummaryContextEntry(db, {
    workflowRunId: params.workflowRunId,
    targetNode: params.targetNode,
    targetAttempt: params.targetAttempt,
  });
  const joinSummaryEntry = buildJoinSummaryContextEntry(db, {
    workflowRunId: params.workflowRunId,
    targetNode: params.targetNode,
    directPredecessors,
    latestReportsByRunNodeId: artifactSelection.latestReportsByRunNodeId,
  });
  const reservedChars =
    (failureRouteContextEntry?.includedChars ?? 0) +
    (retrySummaryEntry?.includedChars ?? 0) +
    (joinSummaryEntry?.includedChars ?? 0);
  const includedCandidateContext = includeContextCandidates(candidateEntries, reservedChars);
  const contextEntries = buildContextEntries({
    workflowRunId: params.workflowRunId,
    targetNodeKey: params.targetNode.nodeKey,
    failureRouteContextEntry,
    joinSummaryEntry,
    includedEntries: includedCandidateContext.includedEntries,
    retrySummaryEntry,
  });

  const hasAnyArtifacts = directPredecessors.some(sourceNode =>
    artifactSelection.runNodeIdsWithAnyArtifacts.has(sourceNode.runNodeId),
  );
  const failureRouteManifestFields = buildFailureRouteManifestFields(failureRouteContextEntry);
  const retrySummaryManifestFields = buildRetrySummaryManifestFields(retrySummaryEntry);
  const manifest: ContextHandoffManifest = {
    context_policy_version: CONTEXT_POLICY_VERSION,
    included_artifact_ids: includedCandidateContext.includedEntries.map(entry => entry.artifactId),
    included_source_node_keys: includedCandidateContext.includedEntries.map(entry => entry.sourceNodeKey),
    included_source_run_node_ids: includedCandidateContext.includedEntries.map(entry => entry.sourceRunNodeId),
    included_count: includedCandidateContext.includedEntries.length,
    included_chars_total: includedCandidateContext.includedEntries.reduce(
      (total, entry) => total + entry.truncation.includedChars,
      0,
    ),
    truncated_artifact_ids: includedCandidateContext.includedEntries
      .filter(entry => entry.truncation.applied)
      .map(entry => entry.artifactId),
    missing_upstream_artifacts: includedCandidateContext.includedEntries.length === 0,
    assembly_timestamp: new Date().toISOString(),
    no_eligible_artifact_types: hasAnyArtifacts && candidateEntries.length === 0,
    budget_overflow: includedCandidateContext.budgetOverflow,
    dropped_artifact_ids: includedCandidateContext.droppedArtifactIds,
    ...failureRouteManifestFields,
    ...retrySummaryManifestFields,
  };

  return {
    contextEntries,
    manifest,
  };
}

export function createEmptyContextManifest(assemblyTimestamp = new Date().toISOString()): ContextHandoffManifest {
  return {
    context_policy_version: CONTEXT_POLICY_VERSION,
    included_artifact_ids: [],
    included_source_node_keys: [],
    included_source_run_node_ids: [],
    included_count: 0,
    included_chars_total: 0,
    truncated_artifact_ids: [],
    missing_upstream_artifacts: true,
    assembly_timestamp: assemblyTimestamp,
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
  };
}
