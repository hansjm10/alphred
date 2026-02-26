import { transitionRunNodeStatus, type AlphredDatabase } from '@alphred/db';
import { loadRunNodeExecutionRows } from './persistence.js';
import { buildRoutingSelection, loadLatestArtifactsByRunNodeId, loadLatestRoutingDecisionsByRunNodeId } from './routing-selection.js';
import { getLatestRunNodeAttempts } from './type-conversions.js';
import type { EdgeRow, LatestArtifact, NextRunnableSelection, RoutingDecisionRow, RunNodeExecutionRow } from './types.js';

export function hasPotentialIncomingRoute(
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
  unresolvedDecisionSourceNodeIds: Set<number>,
): boolean {
  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (!sourceNode) {
      return false;
    }

    if (sourceNode.status === 'completed') {
      if (unresolvedDecisionSourceNodeIds.has(edge.sourceNodeId)) {
        return true;
      }
      return selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) === edge.edgeId;
    }

    return sourceNode.status === 'pending' || sourceNode.status === 'running' || sourceNode.status === 'failed';
  });
}

export function hasRunnableIncomingRoute(
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
): boolean {
  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      return false;
    }

    return selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) === edge.edgeId;
  });
}

export function hasRevisitableIncomingRoute(
  targetNode: RunNodeExecutionRow,
  incomingEdges: EdgeRow[],
  latestByTreeNodeId: Map<number, RunNodeExecutionRow>,
  selectedEdgeIdBySourceNodeId: Map<number, number>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): boolean {
  const targetArtifactId = latestArtifactsByRunNodeId.get(targetNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;

  return incomingEdges.some((edge) => {
    const sourceNode = latestByTreeNodeId.get(edge.sourceNodeId);
    if (sourceNode?.status !== 'completed') {
      return false;
    }

    if (selectedEdgeIdBySourceNodeId.get(edge.sourceNodeId) !== edge.edgeId) {
      return false;
    }

    const sourceArtifactId = latestArtifactsByRunNodeId.get(sourceNode.runNodeId)?.id ?? Number.NEGATIVE_INFINITY;
    return sourceArtifactId > targetArtifactId;
  });
}

export function selectNextRunnableNode(
  rows: RunNodeExecutionRow[],
  edges: EdgeRow[],
  latestRoutingDecisionsByRunNodeId: Map<number, RoutingDecisionRow>,
  latestArtifactsByRunNodeId: Map<number, LatestArtifact>,
): NextRunnableSelection {
  const latestNodeAttempts = getLatestRunNodeAttempts(rows);
  const routingSelection = buildRoutingSelection(
    latestNodeAttempts,
    edges,
    latestRoutingDecisionsByRunNodeId,
    latestArtifactsByRunNodeId,
  );

  const nextRunnableNode =
    latestNodeAttempts.find((row) => {
      if (row.status !== 'pending' && row.status !== 'completed') {
        return false;
      }

      const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(row.treeNodeId) ?? [];
      if (incomingEdges.length === 0) {
        return row.status === 'pending';
      }

      if (row.status === 'pending') {
        return hasRunnableIncomingRoute(
          incomingEdges,
          routingSelection.latestByTreeNodeId,
          routingSelection.selectedEdgeIdBySourceNodeId,
        );
      }

      if (row.status === 'completed') {
        return hasRevisitableIncomingRoute(
          row,
          incomingEdges,
          routingSelection.latestByTreeNodeId,
          routingSelection.selectedEdgeIdBySourceNodeId,
          latestArtifactsByRunNodeId,
        );
      }

      return false;
    }) ?? null;

  return {
    nextRunnableNode,
    latestNodeAttempts,
    hasNoRouteDecision: routingSelection.hasNoRouteDecision,
    hasUnresolvedDecision: routingSelection.hasUnresolvedDecision,
  };
}

export function markUnreachablePendingNodesAsSkipped(
  db: AlphredDatabase,
  workflowRunId: number,
  edgeRows: EdgeRow[],
): void {
  while (true) {
    const latestNodeAttempts = getLatestRunNodeAttempts(loadRunNodeExecutionRows(db, workflowRunId));
    const routingDecisionSelection = loadLatestRoutingDecisionsByRunNodeId(db, workflowRunId);
    const latestArtifactsByRunNodeId = loadLatestArtifactsByRunNodeId(db, workflowRunId);
    const routingSelection = buildRoutingSelection(
      latestNodeAttempts,
      edgeRows,
      routingDecisionSelection.latestByRunNodeId,
      latestArtifactsByRunNodeId,
    );

    const unreachablePendingNode = latestNodeAttempts.find((node) => {
      if (node.status !== 'pending') {
        return false;
      }

      const incomingEdges = routingSelection.incomingEdgesByTargetNodeId.get(node.treeNodeId) ?? [];
      if (incomingEdges.length === 0) {
        return false;
      }

      return !hasPotentialIncomingRoute(
        incomingEdges,
        routingSelection.latestByTreeNodeId,
        routingSelection.selectedEdgeIdBySourceNodeId,
        routingSelection.unresolvedDecisionSourceNodeIds,
      );
    });

    if (!unreachablePendingNode) {
      return;
    }

    transitionRunNodeStatus(db, {
      runNodeId: unreachablePendingNode.runNodeId,
      expectedFrom: 'pending',
      to: 'skipped',
    });
  }
}
