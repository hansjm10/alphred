import { and, asc, eq, inArray } from 'drizzle-orm';
import { phaseArtifacts, routingDecisions, type AlphredDatabase } from '@alphred/db';
import { readRoutingDecisionAttempt, selectFirstMatchingOutgoingEdge } from './routing-decisions.js';
import { normalizeArtifactContentType, toRoutingDecisionType } from './type-conversions.js';
import type {
  EdgeRow,
  LatestArtifact,
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

export function buildRoutingSelection(
  latestNodeAttempts: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): RoutingSelection {
  const latestByTreeNodeId = new Map<number, RunNodeExecutionRow>(latestNodeAttempts.map(row => [row.treeNodeId, row]));
  const incomingEdgesByTargetNodeId = new Map<number, EdgeRow[]>();
  const outgoingEdgesBySourceNodeId = new Map<number, EdgeRow[]>();
  for (const edge of edges) {
    appendEdgeToNodeMap(incomingEdgesByTargetNodeId, edge.targetNodeId, edge);
    appendEdgeToNodeMap(outgoingEdgesBySourceNodeId, edge.sourceNodeId, edge);
  }

  const selectedEdgeIdBySourceNodeId = new Map<number, number>();
  const unresolvedDecisionSourceNodeIds = new Set<number>();
  let hasNoRouteDecision = false;
  for (const sourceNode of latestNodeAttempts) {
    if (sourceNode.status !== 'completed') {
      continue;
    }

    const outgoingEdges = outgoingEdgesBySourceNodeId.get(sourceNode.treeNodeId) ?? [];
    const routing = resolveCompletedSourceNodeRouting(
      sourceNode,
      outgoingEdges,
      latestRoutingDecisionsByRunNodeId,
      latestArtifactsByRunNodeId,
    );
    if (routing.selectedEdgeId !== null) {
      selectedEdgeIdBySourceNodeId.set(sourceNode.treeNodeId, routing.selectedEdgeId);
    }
    if (routing.hasNoRouteDecision) {
      hasNoRouteDecision = true;
    }
    if (routing.hasUnresolvedDecision) {
      unresolvedDecisionSourceNodeIds.add(sourceNode.treeNodeId);
    }
  }

  return {
    latestByTreeNodeId,
    incomingEdgesByTargetNodeId,
    selectedEdgeIdBySourceNodeId,
    unresolvedDecisionSourceNodeIds,
    hasNoRouteDecision,
    hasUnresolvedDecision: unresolvedDecisionSourceNodeIds.size > 0,
  };
}
