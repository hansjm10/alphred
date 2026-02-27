import { MarkerType, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import type {
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationIssue,
} from '../../../../src/server/dashboard-contracts';
import { slugifyKey } from '../../workflows-shared';

type FlowPoint = Readonly<{ x: number; y: number }>;
type ReactFlowNodeData = DashboardWorkflowDraftNode & { label?: string };

export function normalizeEdgeRouteOn(routeOn: DashboardWorkflowDraftEdge['routeOn']): 'success' | 'failure' {
  return routeOn === 'failure' ? 'failure' : 'success';
}

export function buildWorkflowEdgeId(
  sourceNodeKey: string,
  targetNodeKey: string,
  priority: number,
  routeOn: DashboardWorkflowDraftEdge['routeOn'] = 'success',
): string {
  const normalizedRouteOn = normalizeEdgeRouteOn(routeOn);
  if (normalizedRouteOn === 'success') {
    return `${sourceNodeKey}->${targetNodeKey}:${priority}`;
  }

  return `${sourceNodeKey}->${targetNodeKey}:${normalizedRouteOn}:${priority}`;
}

export function toFlowPosition(instance: ReactFlowInstance, point: FlowPoint): FlowPoint | null {
  const maybe = instance as unknown as {
    screenToFlowPosition?: (input: FlowPoint) => FlowPoint;
    project?: (input: FlowPoint) => FlowPoint;
  };

  if (typeof maybe.screenToFlowPosition === 'function') {
    return maybe.screenToFlowPosition(point);
  }

  if (typeof maybe.project === 'function') {
    return maybe.project(point);
  }

  return null;
}

export function slugifyNodeKey(value: string): string {
  return slugifyKey(value, 48);
}

export function nextPriorityForSource(
  edges: readonly DashboardWorkflowDraftEdge[],
  sourceNodeKey: string,
  routeOn: DashboardWorkflowDraftEdge['routeOn'] = 'success',
): number {
  const normalizedRouteOn = normalizeEdgeRouteOn(routeOn);
  const priorities = edges
    .filter(
      edge => edge.sourceNodeKey === sourceNodeKey && normalizeEdgeRouteOn(edge.routeOn) === normalizedRouteOn,
    )
    .map(edge => edge.priority);

  if (priorities.length === 0) {
    return 100;
  }

  return Math.max(...priorities) + 10;
}

export function createConnectedDraftEdge(args: Readonly<{
  sourceNodeKey: string;
  targetNodeKey: string;
  existingEdges: readonly DashboardWorkflowDraftEdge[];
}>): DashboardWorkflowDraftEdge {
  return {
    sourceNodeKey: args.sourceNodeKey,
    targetNodeKey: args.targetNodeKey,
    routeOn: 'success',
    priority: nextPriorityForSource(args.existingEdges, args.sourceNodeKey, 'success'),
    auto: true,
    guardExpression: null,
  };
}

export function formatWorkflowEdgeLabel(
  routeOn: DashboardWorkflowDraftEdge['routeOn'],
  auto: boolean,
  priority: number,
): string {
  const normalizedRouteOn = normalizeEdgeRouteOn(routeOn);
  if (normalizedRouteOn === 'failure') {
    return `failure · ${priority}`;
  }

  return auto ? `auto · ${priority}` : `guard · ${priority}`;
}

function resolveWorkflowEdgeVisuals(routeOn: 'success' | 'failure', auto: boolean): Pick<
  Edge,
  'className' | 'style' | 'labelStyle' | 'labelBgStyle' | 'markerEnd'
> {
  const isFailure = routeOn === 'failure';
  const isGuard = !isFailure && !auto;
  const routeStroke = isFailure ? '#da1e28' : '#198038';

  return {
    className: isFailure
      ? 'workflow-edge workflow-edge--failure'
      : isGuard
        ? 'workflow-edge workflow-edge--success-guard'
        : 'workflow-edge workflow-edge--success-auto',
    style: isFailure
      ? { strokeWidth: 2.5, strokeDasharray: '9 5' }
      : isGuard
        ? { strokeWidth: 2.5, strokeDasharray: '4 4' }
        : { strokeWidth: 2.5 },
    labelStyle: {
      fill: isFailure ? '#7f1d1d' : '#14532d',
      fontWeight: 600,
    },
    labelBgStyle: {
      fill: isFailure ? '#fef2f2' : '#f0fdf4',
      stroke: isFailure ? '#fecaca' : '#bbf7d0',
      strokeWidth: 1,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: routeStroke,
    },
  };
}

export function toReactFlowEdge(edge: DashboardWorkflowDraftEdge): Edge {
  const routeOn = normalizeEdgeRouteOn(edge.routeOn);

  return {
    id: buildWorkflowEdgeId(edge.sourceNodeKey, edge.targetNodeKey, edge.priority, routeOn),
    source: edge.sourceNodeKey,
    target: edge.targetNodeKey,
    label: formatWorkflowEdgeLabel(routeOn, edge.auto, edge.priority),
    data: {
      ...edge,
      routeOn,
    },
    ...resolveWorkflowEdgeVisuals(routeOn, edge.auto),
  };
}

export function buildReactFlowNodes(draft: DashboardWorkflowDraftTopology): Node[] {
  return draft.nodes.map(node => ({
    id: node.nodeKey,
    position: node.position ?? { x: 0, y: 0 },
    data: toReactFlowNodeData(node),
    type: 'default',
  }));
}

export function buildReactFlowEdges(draft: DashboardWorkflowDraftTopology): Edge[] {
  return draft.edges.map(toReactFlowEdge);
}

export function mapNodeFromReactFlow(node: Node): DashboardWorkflowDraftNode {
  const data = { ...(node.data as ReactFlowNodeData) };
  delete data.label;

  const draftNode = data as DashboardWorkflowDraftNode;
  const { executionPermissions, ...nodeWithoutExecutionPermissions } = draftNode;
  return {
    ...nodeWithoutExecutionPermissions,
    ...(executionPermissions ? { executionPermissions } : {}),
    nodeKey: draftNode.nodeKey,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
  };
}

export function toReactFlowNodeData(node: DashboardWorkflowDraftNode): DashboardWorkflowDraftNode & { label: string } {
  return {
    ...node,
    label: node.displayName,
  };
}

export function mapEdgeFromReactFlow(edge: Edge): DashboardWorkflowDraftEdge {
  const data = edge.data as DashboardWorkflowDraftEdge;
  const routeOn = normalizeEdgeRouteOn(data.routeOn);
  return {
    sourceNodeKey: edge.source,
    targetNodeKey: edge.target,
    routeOn,
    priority: data.priority,
    auto: routeOn === 'failure' ? true : data.auto,
    guardExpression: routeOn === 'failure' || data.auto ? null : (data.guardExpression ?? null),
  };
}

function computeInitialRunnableNodeKeys(
  nodes: readonly DashboardWorkflowDraftNode[],
  edges: readonly DashboardWorkflowDraftEdge[],
): string[] {
  const incoming = new Set(edges.map(edge => edge.targetNodeKey));
  return nodes.filter(node => !incoming.has(node.nodeKey)).map(node => node.nodeKey);
}

function hasCycle(
  nodes: readonly DashboardWorkflowDraftNode[],
  edges: readonly DashboardWorkflowDraftEdge[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.nodeKey, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.sourceNodeKey)?.push(edge.targetNodeKey);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(nodeKey: string): boolean {
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }

    visiting.add(nodeKey);
    const targets = adjacency.get(nodeKey) ?? [];
    for (const target of targets) {
      if (visit(target)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  }

  for (const node of nodes) {
    if (visit(node.nodeKey)) {
      return true;
    }
  }

  return false;
}

export function computeWorkflowLiveWarnings(
  nodes: readonly DashboardWorkflowDraftNode[],
  edges: readonly DashboardWorkflowDraftEdge[],
): DashboardWorkflowValidationIssue[] {
  if (nodes.length === 0) {
    return [];
  }

  const warnings: DashboardWorkflowValidationIssue[] = [];
  const initialRunnableNodeKeys = computeInitialRunnableNodeKeys(nodes, edges);
  if (initialRunnableNodeKeys.length === 0) {
    warnings.push({
      code: 'no_initial_nodes',
      message: 'No initial runnable nodes detected. Publishing will fail until at least one node has no incoming transition.',
    });
  } else if (initialRunnableNodeKeys.length > 1) {
    warnings.push({
      code: 'multiple_initial_nodes',
      message: `Multiple initial runnable nodes detected: ${initialRunnableNodeKeys.join(', ')}.`,
    });
  }

  if (hasCycle(nodes, edges)) {
    warnings.push({
      code: 'cycles_present',
      message: 'Cycles are present in the workflow graph.',
    });
  }

  const outgoingBySource = new Map<string, number>();
  for (const edge of edges) {
    outgoingBySource.set(edge.sourceNodeKey, (outgoingBySource.get(edge.sourceNodeKey) ?? 0) + 1);
  }

  for (const node of nodes) {
    if ((outgoingBySource.get(node.nodeKey) ?? 0) === 0) {
      warnings.push({
        code: 'terminal_node',
        message: `Node "${node.nodeKey}" has no outgoing transitions (terminal).`,
      });
    }
  }

  return warnings;
}

function nodeTypeLabel(nodeType: DashboardWorkflowDraftNode['nodeType']): 'Agent' | 'Human' | 'Tool' {
  switch (nodeType) {
    case 'agent':
      return 'Agent';
    case 'human':
      return 'Human';
    case 'tool':
      return 'Tool';
    default:
      return 'Agent';
  }
}

function defaultProvider(nodeType: DashboardWorkflowDraftNode['nodeType']): string | null {
  return nodeType === 'agent' ? 'codex' : null;
}

function defaultModel(nodeType: DashboardWorkflowDraftNode['nodeType']): string | null {
  return nodeType === 'agent' ? 'gpt-5.3-codex' : null;
}

function defaultPromptTemplate(nodeType: DashboardWorkflowDraftNode['nodeType']): DashboardWorkflowDraftNode['promptTemplate'] {
  if (nodeType !== 'agent') {
    return null;
  }

  return { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' };
}

export function createDraftNode(args: Readonly<{
  nodeType: DashboardWorkflowDraftNode['nodeType'];
  existingNodeKeys: ReadonlySet<string>;
  nextSequenceIndex: number;
  position: { x: number; y: number };
}>): DashboardWorkflowDraftNode {
  const baseName = nodeTypeLabel(args.nodeType);
  const keyBase = slugifyNodeKey(baseName) || args.nodeType;

  let nodeKey = keyBase;
  let counter = 2;
  while (args.existingNodeKeys.has(nodeKey)) {
    nodeKey = `${keyBase}-${counter}`;
    counter += 1;
  }

  return {
    nodeKey,
    displayName: baseName,
    nodeType: args.nodeType,
    provider: defaultProvider(args.nodeType),
    model: defaultModel(args.nodeType),
    executionPermissions: null,
    maxRetries: 0,
    sequenceIndex: args.nextSequenceIndex,
    position: { x: Math.round(args.position.x), y: Math.round(args.position.y) },
    promptTemplate: defaultPromptTemplate(args.nodeType),
  };
}

export function duplicateDraftNode(args: Readonly<{
  sourceNode: DashboardWorkflowDraftNode;
  existingNodeKeys: ReadonlySet<string>;
  nextSequenceIndex: number;
}>): DashboardWorkflowDraftNode {
  const keyBase = slugifyNodeKey(args.sourceNode.nodeKey) || 'node';

  let nodeKey = `${keyBase}-copy`;
  let counter = 2;
  while (args.existingNodeKeys.has(nodeKey)) {
    nodeKey = `${keyBase}-copy-${counter}`;
    counter += 1;
  }

  return {
    ...args.sourceNode,
    nodeKey,
    displayName: `${args.sourceNode.displayName} Copy`,
    sequenceIndex: args.nextSequenceIndex,
    position: args.sourceNode.position
      ? { x: Math.round(args.sourceNode.position.x + 40), y: Math.round(args.sourceNode.position.y + 40) }
      : { x: 120, y: 120 },
  };
}
