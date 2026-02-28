import { and, asc, eq, inArray } from 'drizzle-orm';
import { phaseArtifacts, routingDecisions, type AlphredDatabase } from '@alphred/db';
import { ERROR_HANDLER_SUMMARY_METADATA_KIND } from './constants.js';
import { readRoutingDecisionAttempt, selectFirstMatchingOutgoingEdge } from './routing-decisions.js';
import { isRecord, normalizeArtifactContentType, toRoutingDecisionType } from './type-conversions.js';
import type {
  EdgeRow,
  FailureLogArtifact,
  LatestArtifact,
  RetryFailureSummaryArtifact,
  RoutingDecisionRow,
  RoutingDecisionSelection,
  RoutingSelection,
  RunNodeExecutionRow,
  UpstreamArtifactSelection,
  UpstreamReportArtifact,
} from './types.js';

export function loadLatestRoutingDecisionsByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
): RoutingDecisionSelection {
  const rows = db
    .select({
      id: routingDecisions.id,
      runNodeId: routingDecisions.runNodeId,
      decisionType: routingDecisions.decisionType,
      createdAt: routingDecisions.createdAt,
      rawOutput: routingDecisions.rawOutput,
    })
    .from(routingDecisions)
    .where(eq(routingDecisions.workflowRunId, workflowRunId))
    .orderBy(asc(routingDecisions.createdAt), asc(routingDecisions.id))
    .all();

  const latestByRunNodeId = new Map<number, RoutingDecisionRow>();
  for (const row of rows) {
    latestByRunNodeId.set(row.runNodeId, {
      id: row.id,
      runNodeId: row.runNodeId,
      decisionType: toRoutingDecisionType(row.decisionType),
      createdAt: row.createdAt,
      attempt: readRoutingDecisionAttempt(row.rawOutput),
    });
  }

  return {
    latestByRunNodeId,
  };
}

function resolveIntegerMetadataValue(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    return null;
  }

  return value as number;
}

export function loadLatestFailureArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
  },
): FailureLogArtifact | null {
  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      content: phaseArtifacts.content,
      createdAt: phaseArtifacts.createdAt,
      metadata: phaseArtifacts.metadata,
    })
    .from(phaseArtifacts)
    .where(
      and(
        eq(phaseArtifacts.workflowRunId, params.workflowRunId),
        eq(phaseArtifacts.runNodeId, params.runNodeId),
        eq(phaseArtifacts.artifactType, 'log'),
      ),
    )
    .orderBy(asc(phaseArtifacts.createdAt), asc(phaseArtifacts.id))
    .all();

  let latest: FailureLogArtifact | null = null;
  for (const row of rows) {
    latest = {
      id: row.id,
      runNodeId: row.runNodeId,
      content: row.content,
      createdAt: row.createdAt,
      metadata: isRecord(row.metadata) ? row.metadata : null,
    };
  }

  return latest;
}

export function loadRetryFailureSummaryArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    sourceAttempt: number;
    targetAttempt: number;
  },
): RetryFailureSummaryArtifact | null {
  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      content: phaseArtifacts.content,
      createdAt: phaseArtifacts.createdAt,
      metadata: phaseArtifacts.metadata,
    })
    .from(phaseArtifacts)
    .where(
      and(
        eq(phaseArtifacts.workflowRunId, params.workflowRunId),
        eq(phaseArtifacts.runNodeId, params.runNodeId),
        eq(phaseArtifacts.artifactType, 'note'),
      ),
    )
    .orderBy(asc(phaseArtifacts.createdAt), asc(phaseArtifacts.id))
    .all();

  let latest: RetryFailureSummaryArtifact | null = null;
  for (const row of rows) {
    if (!isRecord(row.metadata)) {
      continue;
    }

    if (row.metadata.kind !== ERROR_HANDLER_SUMMARY_METADATA_KIND) {
      continue;
    }

    const sourceAttempt = resolveIntegerMetadataValue(row.metadata, 'sourceAttempt');
    if (sourceAttempt !== params.sourceAttempt) {
      continue;
    }

    const targetAttempt = resolveIntegerMetadataValue(row.metadata, 'targetAttempt');
    if (targetAttempt !== params.targetAttempt) {
      continue;
    }

    const failureArtifactId = resolveIntegerMetadataValue(row.metadata, 'failureArtifactId');
    latest = {
      id: row.id,
      runNodeId: row.runNodeId,
      sourceAttempt,
      targetAttempt,
      failureArtifactId,
      content: row.content,
      createdAt: row.createdAt,
    };
  }

  return latest;
}

export function loadLatestRetryFailureSummaryArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
  },
): RetryFailureSummaryArtifact | null {
  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      content: phaseArtifacts.content,
      createdAt: phaseArtifacts.createdAt,
      metadata: phaseArtifacts.metadata,
    })
    .from(phaseArtifacts)
    .where(
      and(
        eq(phaseArtifacts.workflowRunId, params.workflowRunId),
        eq(phaseArtifacts.runNodeId, params.runNodeId),
        eq(phaseArtifacts.artifactType, 'note'),
      ),
    )
    .orderBy(asc(phaseArtifacts.createdAt), asc(phaseArtifacts.id))
    .all();

  let latest: RetryFailureSummaryArtifact | null = null;
  for (const row of rows) {
    if (!isRecord(row.metadata)) {
      continue;
    }

    if (row.metadata.kind !== ERROR_HANDLER_SUMMARY_METADATA_KIND) {
      continue;
    }

    const sourceAttempt = resolveIntegerMetadataValue(row.metadata, 'sourceAttempt');
    const targetAttempt = resolveIntegerMetadataValue(row.metadata, 'targetAttempt');
    if (sourceAttempt === null || targetAttempt === null) {
      continue;
    }

    const failureArtifactId = resolveIntegerMetadataValue(row.metadata, 'failureArtifactId');
    latest = {
      id: row.id,
      runNodeId: row.runNodeId,
      sourceAttempt,
      targetAttempt,
      failureArtifactId,
      content: row.content,
      createdAt: row.createdAt,
    };
  }

  return latest;
}

export function loadLatestArtifactsByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
): Map<number, LatestArtifact> {
  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      createdAt: phaseArtifacts.createdAt,
    })
    .from(phaseArtifacts)
    .where(eq(phaseArtifacts.workflowRunId, workflowRunId))
    .orderBy(asc(phaseArtifacts.id))
    .all();

  const latestByRunNodeId = new Map<number, LatestArtifact>();
  for (const row of rows) {
    latestByRunNodeId.set(row.runNodeId, {
      id: row.id,
      createdAt: row.createdAt,
    });
  }

  return latestByRunNodeId;
}

export function loadUpstreamArtifactSelectionByRunNodeId(
  db: AlphredDatabase,
  workflowRunId: number,
  runNodeIds: number[],
): UpstreamArtifactSelection {
  const latestReportsByRunNodeId = new Map<number, UpstreamReportArtifact>();
  const runNodeIdsWithAnyArtifacts = new Set<number>();
  if (runNodeIds.length === 0) {
    return {
      latestReportsByRunNodeId,
      runNodeIdsWithAnyArtifacts,
    };
  }

  const rows = db
    .select({
      id: phaseArtifacts.id,
      runNodeId: phaseArtifacts.runNodeId,
      artifactType: phaseArtifacts.artifactType,
      contentType: phaseArtifacts.contentType,
      content: phaseArtifacts.content,
      createdAt: phaseArtifacts.createdAt,
    })
    .from(phaseArtifacts)
    .where(and(eq(phaseArtifacts.workflowRunId, workflowRunId), inArray(phaseArtifacts.runNodeId, runNodeIds)))
    .orderBy(asc(phaseArtifacts.createdAt), asc(phaseArtifacts.id))
    .all();

  for (const row of rows) {
    runNodeIdsWithAnyArtifacts.add(row.runNodeId);
    if (row.artifactType !== 'report') {
      continue;
    }

    latestReportsByRunNodeId.set(row.runNodeId, {
      id: row.id,
      runNodeId: row.runNodeId,
      contentType: normalizeArtifactContentType(row.contentType),
      content: row.content,
      createdAt: row.createdAt,
    });
  }

  return {
    latestReportsByRunNodeId,
    runNodeIdsWithAnyArtifacts,
  };
}

export function appendEdgeToNodeMap(edgesByNodeId: Map<number, EdgeRow[]>, nodeId: number, edge: EdgeRow): void {
  const edges = edgesByNodeId.get(nodeId);
  if (edges) {
    edges.push(edge);
    return;
  }
  edgesByNodeId.set(nodeId, [edge]);
}

export function resolveApplicableRoutingDecision(
  sourceNode: RunNodeExecutionRow,
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RoutingDecisionRow | null {
  const persistedDecision = latestRoutingDecisionsByRunNodeId.get(sourceNode.runNodeId) ?? null;
  if (!persistedDecision) {
    return null;
  }

  const latestArtifact = latestArtifactsByRunNodeId.get(sourceNode.runNodeId) ?? null;
  const hasStaleAttempt = persistedDecision.attempt === null || persistedDecision.attempt < sourceNode.attempt;
  const hasStaleTimestamp = latestArtifact !== null && persistedDecision.createdAt < latestArtifact.createdAt;
  return hasStaleAttempt || hasStaleTimestamp ? null : persistedDecision;
}

export function resolveCompletedSourceNodeRouting(
  sourceNode: RunNodeExecutionRow,
  outgoingEdges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): {
  selectedEdgeId: number | null;
  hasNoRouteDecision: boolean;
  hasUnresolvedDecision: boolean;
} {
  if (outgoingEdges.length === 0) {
    return {
      selectedEdgeId: null,
      hasNoRouteDecision: false,
      hasUnresolvedDecision: false,
    };
  }

  const decision = resolveApplicableRoutingDecision(
    sourceNode,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );
  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decision?.decisionType ?? null);
  if (matchingEdge) {
    return {
      selectedEdgeId: matchingEdge.edgeId,
      hasNoRouteDecision: false,
      hasUnresolvedDecision: false,
    };
  }

  if (decision) {
    return {
      selectedEdgeId: null,
      hasNoRouteDecision: true,
      hasUnresolvedDecision: false,
    };
  }

  return {
    selectedEdgeId: null,
    hasNoRouteDecision: false,
    hasUnresolvedDecision: true,
  };
}

function selectFirstFailureOrTerminalOutgoingEdge(outgoingEdges: EdgeRow[]): EdgeRow | null {
  let terminalEdge: EdgeRow | null = null;
  for (const edge of outgoingEdges) {
    if (edge.routeOn === 'failure') {
      return edge;
    }
    if (edge.routeOn === 'terminal' && terminalEdge === null) {
      terminalEdge = edge;
    }
  }

  return terminalEdge;
}

function isExecutableFailureRouteTarget(node: RunNodeExecutionRow | undefined): boolean {
  if (!node) {
    return false;
  }

  return node.status === 'pending' || node.status === 'running' || node.status === 'completed';
}

type RoutingSelectionMutationState = {
  selectedEdgeIdBySourceNodeId: Map<number, number>;
  handledFailedSourceNodeIds: Set<number>;
  unresolvedDecisionSourceNodeIds: Set<number>;
  hasNoRouteDecision: boolean;
};

function createRoutingSelectionMutationState(): RoutingSelectionMutationState {
  return {
    selectedEdgeIdBySourceNodeId: new Map<number, number>(),
    handledFailedSourceNodeIds: new Set<number>(),
    unresolvedDecisionSourceNodeIds: new Set<number>(),
    hasNoRouteDecision: false,
  };
}

function applyFailedSourceNodeSelection(params: {
  sourceNode: RunNodeExecutionRow;
  outgoingEdges: EdgeRow[];
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>;
  selectionState: RoutingSelectionMutationState;
}): void {
  const { latestByTreeNodeId, outgoingEdges, selectionState, sourceNode } = params;
  const selectedFailureEdge = selectFirstFailureOrTerminalOutgoingEdge(outgoingEdges);
  if (!selectedFailureEdge) {
    return;
  }

  selectionState.selectedEdgeIdBySourceNodeId.set(sourceNode.runNodeId, selectedFailureEdge.edgeId);
  const targetNode = latestByTreeNodeId.get(selectedFailureEdge.targetNodeId);
  if (isExecutableFailureRouteTarget(targetNode)) {
    selectionState.handledFailedSourceNodeIds.add(sourceNode.runNodeId);
  }
}

function applyCompletedSourceNodeSelection(params: {
  sourceNode: RunNodeExecutionRow;
  outgoingEdges: EdgeRow[];
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>;
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>;
  selectionState: RoutingSelectionMutationState;
}): void {
  const {
    latestArtifactsByRunNodeId,
    latestRoutingDecisionsByRunNodeId,
    outgoingEdges,
    selectionState,
    sourceNode,
  } = params;
  const successOutgoingEdges = outgoingEdges.filter(
    edge => edge.routeOn === 'success' && edge.edgeKind === 'tree',
  );
  const routing = resolveCompletedSourceNodeRouting(
    sourceNode,
    successOutgoingEdges,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );

  if (routing.selectedEdgeId !== null) {
    selectionState.selectedEdgeIdBySourceNodeId.set(sourceNode.runNodeId, routing.selectedEdgeId);
  }

  if (routing.hasNoRouteDecision) {
    selectionState.hasNoRouteDecision = true;
  }

  if (routing.hasUnresolvedDecision) {
    selectionState.unresolvedDecisionSourceNodeIds.add(sourceNode.runNodeId);
  }
}

export function buildRoutingSelection(
  latestNodeAttempts: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RoutingSelection {
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>(latestNodeAttempts.map(row => [row.runNodeId, row]));
  const incomingEdgesByTargetNodeId = new Map<number, EdgeRow[]>();
  const outgoingEdgesBySourceNodeId = new Map<number, EdgeRow[]>();
  for (const edge of edges) {
    appendEdgeToNodeMap(incomingEdgesByTargetNodeId, edge.targetNodeId, edge);
    appendEdgeToNodeMap(outgoingEdgesBySourceNodeId, edge.sourceNodeId, edge);
  }

  const selectionState = createRoutingSelectionMutationState();
  for (const sourceNode of latestNodeAttempts) {
    const outgoingEdges = outgoingEdgesBySourceNodeId.get(sourceNode.runNodeId) ?? [];
    if (sourceNode.status === 'failed') {
      applyFailedSourceNodeSelection({
        sourceNode,
        outgoingEdges,
        latestByTreeNodeId,
        selectionState,
      });
      continue;
    }

    if (sourceNode.status === 'completed') {
      applyCompletedSourceNodeSelection({
        sourceNode,
        outgoingEdges,
        latestRoutingDecisionsByRunNodeId,
        latestArtifactsByRunNodeId,
        selectionState,
      });
    }
  }

  return {
    latestByTreeNodeId,
    incomingEdgesByTargetNodeId,
    selectedEdgeIdBySourceNodeId: selectionState.selectedEdgeIdBySourceNodeId,
    handledFailedSourceNodeIds: selectionState.handledFailedSourceNodeIds,
    unresolvedDecisionSourceNodeIds: selectionState.unresolvedDecisionSourceNodeIds,
    hasNoRouteDecision: selectionState.hasNoRouteDecision,
    hasUnresolvedDecision: selectionState.unresolvedDecisionSourceNodeIds.size > 0,
  };
}
