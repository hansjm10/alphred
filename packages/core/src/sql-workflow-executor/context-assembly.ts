import type { AlphredDatabase } from '@alphred/db';
import {
  MAX_ERROR_SUMMARY_CHARS,
  CONTEXT_POLICY_VERSION,
  MAX_CHARS_PER_ARTIFACT,
  MAX_CONTEXT_CHARS_TOTAL,
  MAX_RETRY_SUMMARY_CONTEXT_CHARS,
  MAX_UPSTREAM_ARTIFACTS,
  MIN_REMAINING_CONTEXT_CHARS,
} from './constants.js';
import {
  buildRoutingSelection,
  loadRetryFailureSummaryArtifact,
  loadUpstreamArtifactSelectionByRunNodeId,
} from './routing-selection.js';
import {
  buildTruncationMetadata,
  compareUpstreamSourceOrder,
  hashContentSha256,
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

  const includedEntries: ContextEnvelopeEntry[] = [];
  const droppedArtifactIds: number[] = [];
  const retrySummaryBudget = params.targetAttempt > 1 ? MAX_RETRY_SUMMARY_CONTEXT_CHARS : 0;
  let remainingChars = Math.max(MAX_CONTEXT_CHARS_TOTAL - retrySummaryBudget, 0);
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

  const contextEntries = includedEntries.map(entry =>
    serializeContextEnvelope({
      workflowRunId: params.workflowRunId,
      targetNodeKey: params.targetNode.nodeKey,
      entry,
    }),
  );

  let retrySummaryIncluded = false;
  let retrySummaryArtifactId: number | null = null;
  let retrySummarySourceAttempt: number | null = null;
  let retrySummaryTargetAttempt: number | null = null;
  let retrySummaryChars = 0;
  let retrySummaryTruncated = false;
  if (params.targetAttempt > 1) {
    const retrySummary = loadRetryFailureSummaryArtifact(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.targetNode.runNodeId,
      sourceAttempt: params.targetAttempt - 1,
      targetAttempt: params.targetAttempt,
    });
    if (retrySummary) {
      const summaryCharLimit = Math.min(MAX_ERROR_SUMMARY_CHARS, MAX_RETRY_SUMMARY_CONTEXT_CHARS);
      const includedSummaryContent = truncateHeadTail(retrySummary.content, summaryCharLimit);
      const truncation = buildTruncationMetadata(retrySummary.content.length, includedSummaryContent.length);
      const summaryEntry = serializeRetryFailureSummaryEnvelope({
        workflowRunId: params.workflowRunId,
        targetNodeKey: params.targetNode.nodeKey,
        sourceAttempt: retrySummary.sourceAttempt,
        targetAttempt: retrySummary.targetAttempt,
        summaryArtifactId: retrySummary.id,
        failureArtifactId: retrySummary.failureArtifactId,
        createdAt: retrySummary.createdAt,
        includedContent: includedSummaryContent,
        sha256: hashContentSha256(retrySummary.content),
        truncation,
      });
      contextEntries.push(summaryEntry);
      retrySummaryIncluded = true;
      retrySummaryArtifactId = retrySummary.id;
      retrySummarySourceAttempt = retrySummary.sourceAttempt;
      retrySummaryTargetAttempt = retrySummary.targetAttempt;
      retrySummaryChars = truncation.includedChars;
      retrySummaryTruncated = truncation.applied;
    }
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
    retry_summary_included: false,
    retry_summary_artifact_id: null,
    retry_summary_source_attempt: null,
    retry_summary_target_attempt: null,
    retry_summary_chars: 0,
    retry_summary_truncated: false,
  };
}
