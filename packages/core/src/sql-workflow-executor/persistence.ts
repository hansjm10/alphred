import { asc, eq } from 'drizzle-orm';
import {
  phaseArtifacts,
  runNodeEdges,
  routingDecisions,
  runNodes,
  workflowRuns,
  type AlphredDatabase,
} from '@alphred/db';
import { selectFirstMatchingOutgoingEdge } from './routing-decisions.js';
import { isRecord, normalizeArtifactContentType, toRunNodeStatus, toWorkflowRunStatus } from './type-conversions.js';
import type {
  CompletedNodeRoutingOutcome,
  EdgeRow,
  RouteDecisionSource,
  RunNodeFailureRouteDiagnostics,
  RouteDecisionSignal,
  RoutingDecisionType,
  RunNodeExecutionRow,
  WorkflowRunRow,
} from './types.js';

export function loadWorkflowRunRow(db: AlphredDatabase, workflowRunId: number): WorkflowRunRow {
  const run = db
    .select({
      id: workflowRuns.id,
      workflowTreeId: workflowRuns.workflowTreeId,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, workflowRunId))
    .get();

  if (!run) {
    throw new Error(`Workflow run id=${workflowRunId} was not found.`);
  }

  return {
    id: run.id,
    workflowTreeId: run.workflowTreeId,
    status: toWorkflowRunStatus(run.status),
  };
}

export function loadRunNodeExecutionRows(db: AlphredDatabase, workflowRunId: number): RunNodeExecutionRow[] {
  const rows = db
    .select({
      runNodeId: runNodes.id,
      treeNodeId: runNodes.treeNodeId,
      nodeKey: runNodes.nodeKey,
      nodeRole: runNodes.nodeRole,
      status: runNodes.status,
      sequenceIndex: runNodes.sequenceIndex,
      sequencePath: runNodes.sequencePath,
      lineageDepth: runNodes.lineageDepth,
      spawnerNodeId: runNodes.spawnerNodeId,
      joinNodeId: runNodes.joinNodeId,
      attempt: runNodes.attempt,
      createdAt: runNodes.createdAt,
      startedAt: runNodes.startedAt,
      completedAt: runNodes.completedAt,
      maxRetries: runNodes.maxRetries,
      maxChildren: runNodes.maxChildren,
      nodeType: runNodes.nodeType,
      provider: runNodes.provider,
      model: runNodes.model,
      executionPermissions: runNodes.executionPermissions,
      errorHandlerConfig: runNodes.errorHandlerConfig,
      prompt: runNodes.prompt,
      promptContentType: runNodes.promptContentType,
    })
    .from(runNodes)
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.nodeKey), asc(runNodes.attempt), asc(runNodes.id))
    .all();

  return rows.map(row => ({
    runNodeId: row.runNodeId,
    treeNodeId: row.treeNodeId,
    nodeKey: row.nodeKey,
    nodeRole: row.nodeRole,
    status: toRunNodeStatus(row.status),
    sequenceIndex: row.sequenceIndex,
    sequencePath: row.sequencePath,
    lineageDepth: row.lineageDepth,
    spawnerNodeId: row.spawnerNodeId,
    joinNodeId: row.joinNodeId,
    attempt: row.attempt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    maxRetries: row.maxRetries,
    maxChildren: row.maxChildren,
    nodeType: row.nodeType,
    provider: row.provider,
    model: row.model,
    executionPermissions: row.executionPermissions,
    errorHandlerConfig: row.errorHandlerConfig,
    prompt: row.prompt,
    promptContentType: row.promptContentType,
  }));
}

export function loadRunNodeExecutionRowById(
  db: AlphredDatabase,
  workflowRunId: number,
  runNodeId: number,
): RunNodeExecutionRow {
  const row = loadRunNodeExecutionRows(db, workflowRunId).find(node => node.runNodeId === runNodeId);
  if (!row) {
    throw new Error(`Run node id=${runNodeId} was not found for workflow run id=${workflowRunId}.`);
  }

  return row;
}

export function loadEdgeRows(db: AlphredDatabase, workflowRunId: number): EdgeRow[] {
  const rows = db
    .select({
      edgeId: runNodeEdges.id,
      sourceNodeId: runNodeEdges.sourceRunNodeId,
      targetNodeId: runNodeEdges.targetRunNodeId,
      routeOn: runNodeEdges.routeOn,
      priority: runNodeEdges.priority,
      auto: runNodeEdges.auto,
      guardExpression: runNodeEdges.guardExpression,
      edgeKind: runNodeEdges.edgeKind,
    })
    .from(runNodeEdges)
    .where(eq(runNodeEdges.workflowRunId, workflowRunId))
    .orderBy(
      asc(runNodeEdges.sourceRunNodeId),
      asc(runNodeEdges.routeOn),
      asc(runNodeEdges.priority),
      asc(runNodeEdges.targetRunNodeId),
      asc(runNodeEdges.id),
    )
    .all();

  return rows.map(row => {
    let routeOn: EdgeRow['routeOn'] = 'success';
    if (row.routeOn === 'failure') {
      routeOn = 'failure';
    } else if (row.routeOn === 'terminal') {
      routeOn = 'terminal';
    }

    return {
      ...row,
      routeOn,
      edgeKind:
        row.edgeKind === 'dynamic_spawner_to_child' || row.edgeKind === 'dynamic_child_to_join' ? row.edgeKind : 'tree',
    };
  });
}

export function persistRoutingDecision(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    decisionType: RoutingDecisionType;
    rationale?: string;
    rawOutput?: Record<string, unknown>;
  },
): void {
  db.insert(routingDecisions)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: params.decisionType,
      rationale: params.rationale ?? null,
      rawOutput: params.rawOutput ?? null,
    })
    .run();
}

export function persistCompletedNodeRoutingDecision(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    routingDecision: RouteDecisionSignal | null;
    routingDecisionSource: RouteDecisionSource | null;
    edgeRows: EdgeRow[];
  },
): CompletedNodeRoutingOutcome {
  const decisionSignal = params.routingDecision;
  const routingDecisionSource = params.routingDecisionSource ?? 'provider_result_metadata';
  const outgoingEdges = params.edgeRows.filter(
    edge => edge.sourceNodeId === params.runNodeId && edge.routeOn === 'success',
  );
  const routingOutcome = resolveCompletedNodeRoutingOutcome({
    runNodeId: params.runNodeId,
    routingDecision: decisionSignal,
    edgeRows: params.edgeRows,
  });

  if (routingOutcome.decisionType === null) {
    return routingOutcome;
  }

  if (routingOutcome.decisionType !== 'no_route') {
    persistRoutingDecision(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: routingOutcome.decisionType,
      rawOutput: {
        source: routingDecisionSource,
        routingDecision: decisionSignal,
        ...(routingOutcome.selectedEdgeId === null ? {} : { selectedEdgeId: routingOutcome.selectedEdgeId }),
        attempt: params.attempt,
      },
    });
    return routingOutcome;
  }

  const noRouteRationale =
    decisionSignal === null
      ? `Node completed with guarded success edges but did not emit a valid result.metadata.routingDecision (run_node_id=${params.runNodeId}).`
      : `Node completed with routingDecision="${decisionSignal}" but no guarded success edge matched (run_node_id=${params.runNodeId}).`;

  persistRoutingDecision(db, {
    workflowRunId: params.workflowRunId,
    runNodeId: params.runNodeId,
    decisionType: 'no_route',
    rationale: noRouteRationale,
    rawOutput: {
      source: routingDecisionSource,
      routingDecision: decisionSignal,
      outgoingEdgeIds: outgoingEdges.map(edge => edge.edgeId),
      attempt: params.attempt,
    },
  });

  return routingOutcome;
}

export function resolveCompletedNodeRoutingOutcome(params: {
  runNodeId: number;
  routingDecision: RouteDecisionSignal | null;
  edgeRows: EdgeRow[];
}): CompletedNodeRoutingOutcome {
  const outgoingEdges = params.edgeRows.filter(
    edge => edge.sourceNodeId === params.runNodeId && edge.routeOn === 'success',
  );
  if (outgoingEdges.length === 0) {
    if (!params.routingDecision) {
      return {
        decisionType: null,
        selectedEdgeId: null,
      };
    }

    return {
      decisionType: params.routingDecision,
      selectedEdgeId: null,
    };
  }

  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, params.routingDecision);
  if (matchingEdge) {
    return {
      decisionType: params.routingDecision,
      selectedEdgeId: matchingEdge.edgeId,
    };
  }

  return {
    decisionType: 'no_route',
    selectedEdgeId: null,
  };
}

export function persistSuccessArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    content: string;
    contentType: string | null;
    metadata: Record<string, unknown>;
  },
): number {
  const artifact = db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      artifactType: 'report',
      contentType: normalizeArtifactContentType(params.contentType),
      content: params.content,
      metadata: params.metadata,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

export function persistFailureArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    content: string;
    metadata: Record<string, unknown>;
  },
): number {
  const artifact = db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      artifactType: 'log',
      contentType: 'text',
      content: params.content,
      metadata: params.metadata,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}

export function appendFailureRouteMetadataToArtifact(
  db: AlphredDatabase,
  params: {
    artifactId: number;
    failureRoute: RunNodeFailureRouteDiagnostics;
  },
): void {
  const artifact = db
    .select({
      metadata: phaseArtifacts.metadata,
    })
    .from(phaseArtifacts)
    .where(eq(phaseArtifacts.id, params.artifactId))
    .get();

  if (!artifact) {
    throw new Error(`Failure artifact id=${params.artifactId} was not found.`);
  }

  const existingMetadata = isRecord(artifact.metadata) ? artifact.metadata : {};
  db.update(phaseArtifacts)
    .set({
      metadata: {
        ...existingMetadata,
        failureRoute: params.failureRoute,
      },
    })
    .where(eq(phaseArtifacts.id, params.artifactId))
    .run();
}

export function persistNoteArtifact(
  db: AlphredDatabase,
  params: {
    workflowRunId: number;
    runNodeId: number;
    content: string;
    contentType: string | null;
    metadata: Record<string, unknown>;
  },
): number {
  const artifact = db
    .insert(phaseArtifacts)
    .values({
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      artifactType: 'note',
      contentType: normalizeArtifactContentType(params.contentType),
      content: params.content,
      metadata: params.metadata,
    })
    .returning({ id: phaseArtifacts.id })
    .get();

  return artifact.id;
}
