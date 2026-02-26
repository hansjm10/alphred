import { asc, eq } from 'drizzle-orm';
import {
  guardDefinitions,
  phaseArtifacts,
  promptTemplates,
  routingDecisions,
  runNodes,
  treeEdges,
  treeNodes,
  workflowRuns,
  type AlphredDatabase,
} from '@alphred/db';
import { selectFirstMatchingOutgoingEdge } from './routing-decisions.js';
import { isRecord, normalizeArtifactContentType, toRunNodeStatus, toWorkflowRunStatus } from './type-conversions.js';
import type {
  CompletedNodeRoutingOutcome,
  EdgeRow,
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
      status: runNodes.status,
      sequenceIndex: runNodes.sequenceIndex,
      attempt: runNodes.attempt,
      createdAt: runNodes.createdAt,
      startedAt: runNodes.startedAt,
      completedAt: runNodes.completedAt,
      maxRetries: treeNodes.maxRetries,
      nodeType: treeNodes.nodeType,
      provider: treeNodes.provider,
      model: treeNodes.model,
      executionPermissions: treeNodes.executionPermissions,
      errorHandlerConfig: treeNodes.errorHandlerConfig,
      prompt: promptTemplates.content,
      promptContentType: promptTemplates.contentType,
    })
    .from(runNodes)
    .innerJoin(treeNodes, eq(runNodes.treeNodeId, treeNodes.id))
    .leftJoin(promptTemplates, eq(treeNodes.promptTemplateId, promptTemplates.id))
    .where(eq(runNodes.workflowRunId, workflowRunId))
    .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.nodeKey), asc(runNodes.attempt), asc(runNodes.id))
    .all();

  return rows.map(row => ({
    runNodeId: row.runNodeId,
    treeNodeId: row.treeNodeId,
    nodeKey: row.nodeKey,
    status: toRunNodeStatus(row.status),
    sequenceIndex: row.sequenceIndex,
    attempt: row.attempt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    maxRetries: row.maxRetries,
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

export function loadEdgeRows(db: AlphredDatabase, workflowTreeId: number): EdgeRow[] {
  const rows = db
    .select({
      edgeId: treeEdges.id,
      sourceNodeId: treeEdges.sourceNodeId,
      targetNodeId: treeEdges.targetNodeId,
      routeOn: treeEdges.routeOn,
      priority: treeEdges.priority,
      auto: treeEdges.auto,
      guardExpression: guardDefinitions.expression,
    })
    .from(treeEdges)
    .leftJoin(guardDefinitions, eq(treeEdges.guardDefinitionId, guardDefinitions.id))
    .where(eq(treeEdges.workflowTreeId, workflowTreeId))
    .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.routeOn), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
    .all();

  return rows.map(row => ({
    ...row,
    routeOn: row.routeOn === 'failure' ? 'failure' : 'success',
  }));
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
    treeNodeId: number;
    attempt: number;
    routingDecision: RouteDecisionSignal | null;
    edgeRows: EdgeRow[];
  },
): CompletedNodeRoutingOutcome {
  const decisionSignal = params.routingDecision;
  const outgoingEdges = params.edgeRows.filter(
    edge => edge.sourceNodeId === params.treeNodeId && edge.routeOn === 'success',
  );

  if (outgoingEdges.length === 0) {
    if (!decisionSignal) {
      return {
        decisionType: null,
        selectedEdgeId: null,
      };
    }

    persistRoutingDecision(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: decisionSignal,
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: decisionSignal,
        attempt: params.attempt,
      },
    });
    return {
      decisionType: decisionSignal,
      selectedEdgeId: null,
    };
  }

  const matchingEdge = selectFirstMatchingOutgoingEdge(outgoingEdges, decisionSignal);
  if (matchingEdge) {
    if (!decisionSignal) {
      return {
        decisionType: null,
        selectedEdgeId: matchingEdge.edgeId,
      };
    }

    persistRoutingDecision(db, {
      workflowRunId: params.workflowRunId,
      runNodeId: params.runNodeId,
      decisionType: decisionSignal,
      rawOutput: {
        source: 'provider_result_metadata',
        routingDecision: decisionSignal,
        selectedEdgeId: matchingEdge.edgeId,
        attempt: params.attempt,
      },
    });
    return {
      decisionType: decisionSignal,
      selectedEdgeId: matchingEdge.edgeId,
    };
  }

  persistRoutingDecision(db, {
    workflowRunId: params.workflowRunId,
    runNodeId: params.runNodeId,
    decisionType: 'no_route',
    rationale: `No outgoing edge matched for tree_node_id=${params.treeNodeId}.`,
    rawOutput: {
      source: 'provider_result_metadata',
      routingDecision: decisionSignal,
      outgoingEdgeIds: outgoingEdges.map(edge => edge.edgeId),
      attempt: params.attempt,
    },
  });

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
