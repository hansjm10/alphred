import { and, asc, desc, eq } from 'drizzle-orm';
import type { AlphredDatabase } from './connection.js';
import {
  guardDefinitions,
  promptTemplates,
  runNodeEdges,
  runNodes,
  treeEdges,
  treeNodes,
  workflowRuns,
  workflowTrees,
} from './schema.js';

type TopologyReader = Pick<AlphredDatabase, 'select'>;

export type WorkflowTreeVersion = {
  id: number;
  treeKey: string;
  version: number;
  name: string;
  description: string | null;
};

export type PlannedPromptTemplate = {
  id: number;
  templateKey: string;
  version: number;
  content: string;
  contentType: string;
};

export type PlannedGuardDefinition = {
  id: number;
  guardKey: string;
  version: number;
  expression: unknown;
  description: string | null;
};

export type PlannedTreeNode = {
  id: number;
  nodeKey: string;
  nodeRole: string;
  nodeType: string;
  provider: string | null;
  model: string | null;
  executionPermissions: unknown;
  errorHandlerConfig: unknown;
  maxChildren: number;
  maxRetries: number;
  sequenceIndex: number;
  promptTemplate: PlannedPromptTemplate | null;
};

export type PlannedTreeEdge = {
  id: number;
  sourceNodeId: number;
  targetNodeId: number;
  routeOn: 'success' | 'failure';
  priority: number;
  auto: boolean;
  guardDefinition: PlannedGuardDefinition | null;
};

export type WorkflowTreeTopology = {
  tree: WorkflowTreeVersion;
  nodes: PlannedTreeNode[];
  edges: PlannedTreeEdge[];
  initialRunnableNodeKeys: string[];
};

export type LoadWorkflowTreeTopologyParams = {
  treeKey: string;
  /**
   * If omitted, the active version is resolved as the highest `workflow_trees.version`
   * for `treeKey`. Missing trees throw `WorkflowTreeNotFoundError`; ties at the highest
   * version throw `AmbiguousWorkflowTreeVersionError`.
   */
  treeVersion?: number;
};

export type MaterializeWorkflowRunParams = {
  treeKey: string;
  treeVersion?: number;
  runStatus?: 'pending' | 'running';
  runStartedAt?: string;
};

export type MaterializedRunNode = {
  id: number;
  treeNodeId: number;
  nodeKey: string;
  status: string;
  sequenceIndex: number;
  attempt: number;
  isInitialRunnable: boolean;
};

export type MaterializedWorkflowRun = {
  run: {
    id: number;
    workflowTreeId: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  topology: WorkflowTreeTopology;
  initialRunnableNodeKeys: string[];
  runNodes: MaterializedRunNode[];
};

export class WorkflowTreeNotFoundError extends Error {
  readonly code = 'WORKFLOW_TREE_NOT_FOUND';

  constructor(readonly treeKey: string, readonly treeVersion?: number) {
    const versionDescription = treeVersion === undefined ? 'active version' : `version ${treeVersion}`;
    super(`No workflow tree found for tree_key="${treeKey}" (${versionDescription}).`);
    this.name = 'WorkflowTreeNotFoundError';
  }
}

export class AmbiguousWorkflowTreeVersionError extends Error {
  readonly code = 'AMBIGUOUS_WORKFLOW_TREE_VERSION';

  constructor(
    readonly treeKey: string,
    readonly version: number,
    readonly candidateTreeIds: number[],
  ) {
    super(
      `Ambiguous active workflow tree version for tree_key="${treeKey}" and version=${version}; candidates=${candidateTreeIds.join(',')}.`,
    );
    this.name = 'AmbiguousWorkflowTreeVersionError';
  }
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function requireJoinedField<T>(value: T | null, fieldName: string): T {
  if (value === null) {
    throw new Error(`Expected joined field "${fieldName}" to be present.`);
  }

  return value;
}

function compareStringsByCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

function sortPlannedNodes(nodes: PlannedTreeNode[]): PlannedTreeNode[] {
  return [...nodes].sort((a, b) => {
    const bySequence = compareNumbers(a.sequenceIndex, b.sequenceIndex);
    if (bySequence !== 0) {
      return bySequence;
    }

    const byKey = compareStringsByCodeUnit(a.nodeKey, b.nodeKey);
    if (byKey !== 0) {
      return byKey;
    }

    return compareNumbers(a.id, b.id);
  });
}

function sortPlannedEdges(edges: PlannedTreeEdge[], nodes: PlannedTreeNode[]): PlannedTreeEdge[] {
  const sequenceByNodeId = new Map<number, number>(nodes.map(node => [node.id, node.sequenceIndex]));

  return [...edges].sort((a, b) => {
    const sourceSequenceA = sequenceByNodeId.get(a.sourceNodeId) ?? Number.MAX_SAFE_INTEGER;
    const sourceSequenceB = sequenceByNodeId.get(b.sourceNodeId) ?? Number.MAX_SAFE_INTEGER;
    const bySourceSequence = compareNumbers(sourceSequenceA, sourceSequenceB);
    if (bySourceSequence !== 0) {
      return bySourceSequence;
    }

    const byRouteOn = compareStringsByCodeUnit(a.routeOn, b.routeOn);
    if (byRouteOn !== 0) {
      return byRouteOn;
    }

    const byPriority = compareNumbers(a.priority, b.priority);
    if (byPriority !== 0) {
      return byPriority;
    }

    const targetSequenceA = sequenceByNodeId.get(a.targetNodeId) ?? Number.MAX_SAFE_INTEGER;
    const targetSequenceB = sequenceByNodeId.get(b.targetNodeId) ?? Number.MAX_SAFE_INTEGER;
    const byTargetSequence = compareNumbers(targetSequenceA, targetSequenceB);
    if (byTargetSequence !== 0) {
      return byTargetSequence;
    }

    return compareNumbers(a.id, b.id);
  });
}

function computeInitialRunnableNodeKeys(nodes: PlannedTreeNode[], edges: PlannedTreeEdge[]): string[] {
  const hasIncomingEdge = new Set<number>(edges.map(edge => edge.targetNodeId));

  return nodes
    .filter(node => !hasIncomingEdge.has(node.id))
    .map(node => node.nodeKey);
}

/**
 * Resolves the single active tree version for a `treeKey`.
 * Throws when no candidates exist or when the highest version is ambiguous.
 */
export function selectActiveWorkflowTreeVersion(
  candidates: WorkflowTreeVersion[],
  treeKey: string,
): WorkflowTreeVersion {
  if (candidates.length === 0) {
    throw new WorkflowTreeNotFoundError(treeKey);
  }

  const maxVersion = Math.max(...candidates.map(candidate => candidate.version));
  const activeCandidates = candidates.filter(candidate => candidate.version === maxVersion);
  if (activeCandidates.length > 1) {
    throw new AmbiguousWorkflowTreeVersionError(
      treeKey,
      maxVersion,
      activeCandidates.map(candidate => candidate.id),
    );
  }

  return activeCandidates[0];
}

/**
 * Resolves an explicit tree version when provided, otherwise resolves the active version.
 * This function is the source of truth for version-selection behavior used by planner APIs.
 */
function resolveWorkflowTreeVersion(db: TopologyReader, params: LoadWorkflowTreeTopologyParams): WorkflowTreeVersion {
  if (params.treeVersion !== undefined) {
    const exactVersion = db
      .select({
        id: workflowTrees.id,
        treeKey: workflowTrees.treeKey,
        version: workflowTrees.version,
        name: workflowTrees.name,
        description: workflowTrees.description,
      })
      .from(workflowTrees)
      .where(and(eq(workflowTrees.treeKey, params.treeKey), eq(workflowTrees.version, params.treeVersion)))
      .get();

    if (!exactVersion) {
      throw new WorkflowTreeNotFoundError(params.treeKey, params.treeVersion);
    }

    return exactVersion;
  }

  const candidates = db
    .select({
      id: workflowTrees.id,
      treeKey: workflowTrees.treeKey,
      version: workflowTrees.version,
      name: workflowTrees.name,
      description: workflowTrees.description,
    })
    .from(workflowTrees)
    .where(and(eq(workflowTrees.treeKey, params.treeKey), eq(workflowTrees.status, 'published')))
    .orderBy(desc(workflowTrees.version), desc(workflowTrees.id))
    .all();

  return selectActiveWorkflowTreeVersion(candidates, params.treeKey);
}

export function loadWorkflowTreeTopology(
  db: TopologyReader,
  params: LoadWorkflowTreeTopologyParams,
): WorkflowTreeTopology {
  const tree = resolveWorkflowTreeVersion(db, params);

  const nodeRows = db
    .select({
      nodeId: treeNodes.id,
      nodeKey: treeNodes.nodeKey,
      nodeType: treeNodes.nodeType,
      nodeRole: treeNodes.nodeRole,
      provider: treeNodes.provider,
      model: treeNodes.model,
      executionPermissions: treeNodes.executionPermissions,
      errorHandlerConfig: treeNodes.errorHandlerConfig,
      maxChildren: treeNodes.maxChildren,
      maxRetries: treeNodes.maxRetries,
      sequenceIndex: treeNodes.sequenceIndex,
      promptTemplateId: promptTemplates.id,
      promptTemplateKey: promptTemplates.templateKey,
      promptTemplateVersion: promptTemplates.version,
      promptTemplateContent: promptTemplates.content,
      promptTemplateContentType: promptTemplates.contentType,
    })
    .from(treeNodes)
    .leftJoin(promptTemplates, eq(treeNodes.promptTemplateId, promptTemplates.id))
    .where(eq(treeNodes.workflowTreeId, tree.id))
    .orderBy(asc(treeNodes.sequenceIndex), asc(treeNodes.nodeKey), asc(treeNodes.id))
    .all();

  const nodes = sortPlannedNodes(
    nodeRows.map(row => ({
      id: row.nodeId,
      nodeKey: row.nodeKey,
      nodeType: row.nodeType,
      nodeRole: row.nodeRole,
      provider: row.provider,
      model: row.model,
      executionPermissions: row.executionPermissions,
      errorHandlerConfig: row.errorHandlerConfig,
      maxChildren: row.maxChildren,
      maxRetries: row.maxRetries,
      sequenceIndex: row.sequenceIndex,
      promptTemplate:
        row.promptTemplateId === null
          ? null
          : {
              id: row.promptTemplateId,
              templateKey: requireJoinedField(row.promptTemplateKey, 'prompt_templates.template_key'),
              version: requireJoinedField(row.promptTemplateVersion, 'prompt_templates.version'),
              content: requireJoinedField(row.promptTemplateContent, 'prompt_templates.content'),
              contentType: requireJoinedField(row.promptTemplateContentType, 'prompt_templates.content_type'),
            },
    })),
  );

  const edgeRows = db
    .select({
      edgeId: treeEdges.id,
      sourceNodeId: treeEdges.sourceNodeId,
      targetNodeId: treeEdges.targetNodeId,
      routeOn: treeEdges.routeOn,
      priority: treeEdges.priority,
      auto: treeEdges.auto,
      guardDefinitionId: guardDefinitions.id,
      guardKey: guardDefinitions.guardKey,
      guardVersion: guardDefinitions.version,
      guardExpression: guardDefinitions.expression,
      guardDescription: guardDefinitions.description,
    })
    .from(treeEdges)
    .leftJoin(guardDefinitions, eq(treeEdges.guardDefinitionId, guardDefinitions.id))
    .where(eq(treeEdges.workflowTreeId, tree.id))
    .orderBy(asc(treeEdges.sourceNodeId), asc(treeEdges.routeOn), asc(treeEdges.priority), asc(treeEdges.targetNodeId), asc(treeEdges.id))
    .all();

  const edges = sortPlannedEdges(
    edgeRows.map(row => ({
      id: row.edgeId,
      sourceNodeId: row.sourceNodeId,
      targetNodeId: row.targetNodeId,
      routeOn: row.routeOn === 'failure' ? 'failure' : 'success',
      priority: row.priority,
      auto: row.auto === 1,
      guardDefinition:
        row.guardDefinitionId === null
          ? null
          : {
              id: row.guardDefinitionId,
              guardKey: requireJoinedField(row.guardKey, 'guard_definitions.guard_key'),
              version: requireJoinedField(row.guardVersion, 'guard_definitions.version'),
              expression: row.guardExpression,
              description: row.guardDescription,
            },
    })),
    nodes,
  );

  return {
    tree,
    nodes,
    edges,
    initialRunnableNodeKeys: computeInitialRunnableNodeKeys(nodes, edges),
  };
}

export function materializeWorkflowRunFromTree(
  db: AlphredDatabase,
  params: MaterializeWorkflowRunParams,
): MaterializedWorkflowRun {
  const runStatus = params.runStatus ?? 'pending';
  const runStartedAt = runStatus === 'running' ? (params.runStartedAt ?? new Date().toISOString()) : null;

  return db.transaction(tx => {
    // Keep topology resolution and persistence in one transaction snapshot.
    const topology = loadWorkflowTreeTopology(tx, params);

    const run = tx
      .insert(workflowRuns)
      .values({
        workflowTreeId: topology.tree.id,
        status: runStatus,
        startedAt: runStartedAt,
      })
      .returning({
        id: workflowRuns.id,
        workflowTreeId: workflowRuns.workflowTreeId,
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .get();

    if (topology.nodes.length > 0) {
      tx
        .insert(runNodes)
        .values(
          topology.nodes.map(node => ({
            workflowRunId: run.id,
            treeNodeId: node.id,
            nodeKey: node.nodeKey,
            nodeRole: node.nodeRole,
            nodeType: node.nodeType,
            provider: node.provider,
            model: node.model,
            prompt: node.promptTemplate?.content ?? null,
            promptContentType: node.promptTemplate?.contentType ?? 'markdown',
            executionPermissions: node.executionPermissions ?? null,
            errorHandlerConfig: node.errorHandlerConfig ?? null,
            maxChildren: node.maxChildren,
            maxRetries: node.maxRetries,
            spawnerNodeId: null,
            joinNodeId: null,
            lineageDepth: 0,
            sequencePath: String(node.sequenceIndex),
            status: 'pending',
            sequenceIndex: node.sequenceIndex,
            attempt: 1,
          })),
        )
        .run();
    }

    const persistedRunNodes = tx
      .select({
        id: runNodes.id,
        treeNodeId: runNodes.treeNodeId,
        nodeKey: runNodes.nodeKey,
        status: runNodes.status,
        sequenceIndex: runNodes.sequenceIndex,
        attempt: runNodes.attempt,
      })
      .from(runNodes)
      .where(eq(runNodes.workflowRunId, run.id))
      .orderBy(asc(runNodes.sequenceIndex), asc(runNodes.nodeKey), asc(runNodes.id))
      .all();

    if (persistedRunNodes.length > 0 && topology.edges.length > 0) {
      const runNodeIdByTreeNodeId = new Map<number, number>(persistedRunNodes.map(node => [node.treeNodeId, node.id]));
      tx
        .insert(runNodeEdges)
        .values(
          topology.edges.map(edge => {
            const sourceRunNodeId = runNodeIdByTreeNodeId.get(edge.sourceNodeId);
            const targetRunNodeId = runNodeIdByTreeNodeId.get(edge.targetNodeId);
            if (!sourceRunNodeId || !targetRunNodeId) {
              throw new Error(
                `Failed to materialize runtime edges for workflow run id=${run.id}: missing source/target run node for tree edge id=${edge.id}.`,
              );
            }

            return {
              workflowRunId: run.id,
              sourceRunNodeId,
              targetRunNodeId,
              routeOn: edge.routeOn,
              auto: edge.auto ? 1 : 0,
              guardExpression: edge.guardDefinition?.expression ?? null,
              priority: edge.priority,
              edgeKind: 'tree',
            };
          }),
        )
        .run();
    }

    const initialRunnableNodeKeys = topology.initialRunnableNodeKeys;
    const initialRunnableNodeKeySet = new Set(initialRunnableNodeKeys);

    return {
      run,
      topology,
      initialRunnableNodeKeys,
      runNodes: persistedRunNodes.map(runNode => ({
        id: runNode.id,
        treeNodeId: runNode.treeNodeId,
        nodeKey: runNode.nodeKey,
        status: runNode.status,
        sequenceIndex: runNode.sequenceIndex,
        attempt: runNode.attempt,
        isInitialRunnable: initialRunnableNodeKeySet.has(runNode.nodeKey),
      })),
    };
  });
}
