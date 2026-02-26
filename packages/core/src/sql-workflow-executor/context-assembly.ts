import type { AlphredDatabase } from '@alphred/db';
import {
  MAX_ERROR_SUMMARY_CHARS,
  CONTEXT_POLICY_VERSION,
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
  loadLatestRetryFailureSummaryArtifact,
  loadRetryFailureSummaryArtifact,
  loadUpstreamArtifactSelectionByRunNodeId,
} from './routing-selection.js';
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
  LatestArtifact,
  RoutingDecisionRow,
  RunNodeExecutionRow,
} from './types.js';

export function selectDirectPredecessorNodes(
  targetNode: RunNodeExecutionRow,
  latestNodeAttempts: RunNodeExecutionRow[],
  edgeRows: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RunNodeExecutionRow[] {
  const routingSelection = buildRoutingSelection(
    latestNodeAttempts,
    edgeRows,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );
  const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(targetNode.treeNodeId) ?? [];

  const predecessors: RunNodeExecutionRow[] = [];
  const seenSourceNodeIds = new Set<number>();
  for (const edge of incomingEdges) {
    if (edge.routeOn !== 'success') {
      continue;
    }

    if (routingSelection.selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      continue;
    }

    if (seenSourceNodeIds.has(edge.sourceNodeId)) {
      continue;
    }

    const sourceNode = routingSelection.latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      continue;
    }

    seenSourceNodeIds.add(edge.sourceNodeId);
    predecessors.push(sourceNode);
  }

  return predecessors.sort(compareUpstreamSourceOrder);
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
  const directPredecessors = selectDirectPredecessorNodes(
    params.targetNode,
    params.latestNodeAttempts,
    params.edgeRows,
    params.latestRoutingDecisionsByRunNodeId,
    params.latestArtifactsByRunNodeId,
  );
  const predecessorRunNodeIds = directPredecessors.map(node => node.runNodeId);
  const artifactSelection = loadUpstreamArtifactSelectionByRunNodeId(db, params.workflowRunId, predecessorRunNodeIds);

  const candidateEntries: ContextEnvelopeCandidate[] = [];
  for (const sourceNode of directPredecessors) {
    const artifact = artifactSelection.latestReportsByRunNodeId.get(sourceNode.runNodeId);
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

  const routingSelection = buildRoutingSelection(
    params.latestNodeAttempts,
    params.edgeRows,
    params.latestRoutingDecisionsByRunNodeId,
    params.latestArtifactsByRunNodeId,
  );
  const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(params.targetNode.treeNodeId) ?? [];
  const selectedFailureEdge = incomingEdges.find((edge) => {
    if (edge.routeOn !== 'failure') {
      return false;
    }

    if (routingSelection.selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      return false;
    }

    const sourceNode = routingSelection.latestByTreeNodeId.get(edge.sourceNodeId);
    return sourceNode?.status === 'failed';
  }) ?? null;

  const failureRouteSourceNode = selectedFailureEdge
    ? (routingSelection.latestByTreeNodeId.get(selectedFailureEdge.sourceNodeId) ?? null)
    : null;
  const failureRouteFailureArtifact = failureRouteSourceNode
    ? loadLatestFailureArtifact(db, {
        workflowRunId: params.workflowRunId,
        runNodeId: failureRouteSourceNode.runNodeId,
      })
    : null;
  const failureRouteRetrySummaryArtifact = failureRouteSourceNode
    ? loadLatestRetryFailureSummaryArtifact(db, {
        workflowRunId: params.workflowRunId,
        runNodeId: failureRouteSourceNode.runNodeId,
      })
    : null;
  const failureRouteContextEntry =
    failureRouteSourceNode && failureRouteFailureArtifact
      ? (() => {
          const failureReason =
            failureRouteFailureArtifact.metadata && typeof failureRouteFailureArtifact.metadata.failureReason === 'string'
              ? failureRouteFailureArtifact.metadata.failureReason
              : (failureRouteSourceNode.attempt > failureRouteSourceNode.maxRetries
                  ? 'retry_limit_exceeded'
                  : 'failure');
          let rawPayload = [
            'attempt_metadata:',
            `  attempt: ${failureRouteSourceNode.attempt}`,
            `  max_retries: ${failureRouteSourceNode.maxRetries}`,
            `  retries_exhausted: ${failureRouteSourceNode.attempt > failureRouteSourceNode.maxRetries ? 'true' : 'false'}`,
            `  retries_used: ${Math.max(failureRouteSourceNode.attempt - 1, 0)}`,
            `  failure_reason: ${failureReason}`,
            'failure_artifact:',
            `  id: ${failureRouteFailureArtifact.id}`,
            `  created_at: ${failureRouteFailureArtifact.createdAt}`,
            '  content:',
            failureRouteFailureArtifact.content,
          ].join('\n');
          if (failureRouteRetrySummaryArtifact) {
            rawPayload = `${rawPayload}\nretry_summary_artifact:\n  id: ${failureRouteRetrySummaryArtifact.id}\n  source_attempt: ${failureRouteRetrySummaryArtifact.sourceAttempt}\n  target_attempt: ${failureRouteRetrySummaryArtifact.targetAttempt}\n  failure_artifact_id: ${failureRouteRetrySummaryArtifact.failureArtifactId === null ? 'null' : String(failureRouteRetrySummaryArtifact.failureArtifactId)}\n  created_at: ${failureRouteRetrySummaryArtifact.createdAt}\n  content:\n${failureRouteRetrySummaryArtifact.content}`;
          }

          const includedContent = truncateHeadTail(rawPayload, MAX_FAILURE_ROUTE_CONTEXT_CHARS);
          const truncation = buildTruncationMetadata(rawPayload.length, includedContent.length);

          return {
            entry: serializeFailureRouteContextEnvelope({
              workflowRunId: params.workflowRunId,
              targetNodeKey: params.targetNode.nodeKey,
              sourceNodeKey: failureRouteSourceNode.nodeKey,
              sourceRunNodeId: failureRouteSourceNode.runNodeId,
              sourceAttempt: failureRouteSourceNode.attempt,
              failureArtifactId: failureRouteFailureArtifact.id,
              retrySummaryArtifactId: failureRouteRetrySummaryArtifact?.id ?? null,
              createdAt: failureRouteFailureArtifact.createdAt,
              includedContent,
              truncation,
            }),
            sourceNodeKey: failureRouteSourceNode.nodeKey,
            sourceRunNodeId: failureRouteSourceNode.runNodeId,
            failureArtifactId: failureRouteFailureArtifact.id,
            retrySummaryArtifactId: failureRouteRetrySummaryArtifact?.id ?? null,
            includedChars: truncation.includedChars,
            truncated: truncation.applied,
          };
        })()
      : null;

  const retrySummaryCandidate =
    params.targetAttempt > 1
      ? loadRetryFailureSummaryArtifact(db, {
          workflowRunId: params.workflowRunId,
          runNodeId: params.targetNode.runNodeId,
          sourceAttempt: params.targetAttempt - 1,
          targetAttempt: params.targetAttempt,
        })
      : null;
  const retrySummaryEntry = retrySummaryCandidate
    ? (() => {
        const summaryCharLimit = Math.min(MAX_ERROR_SUMMARY_CHARS, MAX_RETRY_SUMMARY_CONTEXT_CHARS);
        const includedSummaryContent = truncateHeadTail(retrySummaryCandidate.content, summaryCharLimit);
        const truncation = buildTruncationMetadata(retrySummaryCandidate.content.length, includedSummaryContent.length);

        return {
          entry: serializeRetryFailureSummaryEnvelope({
            workflowRunId: params.workflowRunId,
            targetNodeKey: params.targetNode.nodeKey,
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
      })()
    : null;

  const includedEntries: ContextEnvelopeEntry[] = [];
  const droppedArtifactIds: number[] = [];
  const failureRouteBudget = failureRouteContextEntry?.includedChars ?? 0;
  const retrySummaryBudget = retrySummaryEntry?.includedChars ?? 0;
  let remainingChars = Math.max(MAX_CONTEXT_CHARS_TOTAL - failureRouteBudget - retrySummaryBudget, 0);
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

  const contextEntries: string[] = [];
  if (failureRouteContextEntry) {
    contextEntries.push(failureRouteContextEntry.entry);
  }
  contextEntries.push(...includedEntries.map(entry =>
    serializeContextEnvelope({
      workflowRunId: params.workflowRunId,
      targetNodeKey: params.targetNode.nodeKey,
      entry,
    }),
  ));

  let retrySummaryIncluded = false;
  let retrySummaryArtifactId: number | null = null;
  let retrySummarySourceAttempt: number | null = null;
  let retrySummaryTargetAttempt: number | null = null;
  let retrySummaryChars = 0;
  let retrySummaryTruncated = false;
  if (retrySummaryEntry) {
    contextEntries.push(retrySummaryEntry.entry);
    retrySummaryIncluded = true;
    retrySummaryArtifactId = retrySummaryEntry.artifactId;
    retrySummarySourceAttempt = retrySummaryEntry.sourceAttempt;
    retrySummaryTargetAttempt = retrySummaryEntry.targetAttempt;
    retrySummaryChars = retrySummaryEntry.includedChars;
    retrySummaryTruncated = retrySummaryEntry.truncated;
  }

  const hasAnyArtifacts = directPredecessors.some(sourceNode =>
    artifactSelection.runNodeIdsWithAnyArtifacts.has(sourceNode.runNodeId),
  );
  const manifest: ContextHandoffManifest = {
    context_policy_version: CONTEXT_POLICY_VERSION,
    included_artifact_ids: includedEntries.map(entry => entry.artifactId),
    included_source_node_keys: includedEntries.map(entry => entry.sourceNodeKey),
    included_source_run_node_ids: includedEntries.map(entry => entry.sourceRunNodeId),
    included_count: includedEntries.length,
    included_chars_total: includedEntries.reduce((total, entry) => total + entry.truncation.includedChars, 0),
    truncated_artifact_ids: includedEntries
      .filter(entry => entry.truncation.applied)
      .map(entry => entry.artifactId),
    missing_upstream_artifacts: includedEntries.length === 0,
    assembly_timestamp: new Date().toISOString(),
    no_eligible_artifact_types: hasAnyArtifacts && candidateEntries.length === 0,
    budget_overflow: budgetOverflow,
    dropped_artifact_ids: droppedArtifactIds,
    failure_route_context_included: failureRouteContextEntry !== null,
    failure_route_source_node_key: failureRouteContextEntry?.sourceNodeKey ?? null,
    failure_route_source_run_node_id: failureRouteContextEntry?.sourceRunNodeId ?? null,
    failure_route_failure_artifact_id: failureRouteContextEntry?.failureArtifactId ?? null,
    failure_route_retry_summary_artifact_id: failureRouteContextEntry?.retrySummaryArtifactId ?? null,
    failure_route_context_chars: failureRouteContextEntry?.includedChars ?? 0,
    failure_route_context_truncated: failureRouteContextEntry?.truncated ?? false,
    retry_summary_included: retrySummaryIncluded,
    retry_summary_artifact_id: retrySummaryArtifactId,
    retry_summary_source_attempt: retrySummarySourceAttempt,
    retry_summary_target_attempt: retrySummaryTargetAttempt,
    retry_summary_chars: retrySummaryChars,
    retry_summary_truncated: retrySummaryTruncated,
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
