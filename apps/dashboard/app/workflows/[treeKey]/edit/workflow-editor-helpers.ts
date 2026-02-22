import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import type {
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
} from '../../../../src/server/dashboard-contracts';
import { slugifyKey } from '../../workflows-shared';

type FlowPoint = Readonly<{ x: number; y: number }>;

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

export function nextPriorityForSource(edges: readonly DashboardWorkflowDraftEdge[], sourceNodeKey: string): number {
  const priorities = edges
    .filter(edge => edge.sourceNodeKey === sourceNodeKey)
    .map(edge => edge.priority);

  if (priorities.length === 0) {
    return 100;
  }

  return Math.max(...priorities) + 10;
}

export function buildReactFlowNodes(draft: DashboardWorkflowDraftTopology): Node[] {
  return draft.nodes.map(node => ({
    id: node.nodeKey,
    position: node.position ?? { x: 0, y: 0 },
    data: {
      ...node,
    },
    type: 'default',
  }));
}

export function buildReactFlowEdges(draft: DashboardWorkflowDraftTopology): Edge[] {
  return draft.edges.map(edge => ({
    id: `${edge.sourceNodeKey}->${edge.targetNodeKey}:${edge.priority}`,
    source: edge.sourceNodeKey,
    target: edge.targetNodeKey,
    label: edge.auto ? `auto · ${edge.priority}` : `guard · ${edge.priority}`,
    data: {
      ...edge,
    },
  }));
}

export function mapNodeFromReactFlow(node: Node): DashboardWorkflowDraftNode {
  const data = node.data as DashboardWorkflowDraftNode;
  return {
    ...data,
    nodeKey: data.nodeKey,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
  };
}

export function mapEdgeFromReactFlow(edge: Edge): DashboardWorkflowDraftEdge {
  const data = edge.data as DashboardWorkflowDraftEdge;
  return {
    sourceNodeKey: edge.source,
    targetNodeKey: edge.target,
    priority: data.priority,
    auto: data.auto,
    guardExpression: data.auto ? null : (data.guardExpression ?? null),
  };
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
    maxRetries: 0,
    sequenceIndex: args.nextSequenceIndex,
    position: { x: Math.round(args.position.x), y: Math.round(args.position.y) },
    promptTemplate: defaultPromptTemplate(args.nodeType),
  };
}

