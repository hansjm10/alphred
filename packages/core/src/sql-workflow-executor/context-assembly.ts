import type { AlphredDatabase } from '@alphred/db';
import {
  CONTEXT_POLICY_VERSION,
  MAX_CHARS_PER_ARTIFACT,
  MAX_CONTEXT_CHARS_TOTAL,
  MAX_UPSTREAM_ARTIFACTS,
  MIN_REMAINING_CONTEXT_CHARS,
} from './constants.js';
import { buildRoutingSelection, loadUpstreamArtifactSelectionByRunNodeId } from './routing-selection.js';
import {
  buildTruncationMetadata,
  compareUpstreamSourceOrder,
  hashContentSha256,
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
  let remainingChars = MAX_CONTEXT_CHARS_TOTAL;
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
  };
}
