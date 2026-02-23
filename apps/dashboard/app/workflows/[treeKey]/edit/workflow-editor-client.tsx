'use client';

import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Panel, StatusBadge } from '../../../ui/primitives';
import { resolveApiError } from '../../workflows-shared';
import { WorkflowEditorAddNodeDialog } from './workflow-editor-add-node-dialog';
import {
  buildWorkflowEdgeId,
  buildReactFlowEdges,
  buildReactFlowNodes,
  computeWorkflowLiveWarnings,
  createConnectedDraftEdge,
  createDraftNode,
  duplicateDraftNode,
  mapEdgeFromReactFlow,
  mapNodeFromReactFlow,
  toReactFlowNodeData,
  toFlowPosition,
} from './workflow-editor-helpers';
import {
  useDraftAutosave,
  useWorkflowHistory,
  useWorkflowKeyboardShortcuts,
  type SaveState,
  type WorkflowSnapshot,
} from './workflow-editor-hooks';
import { EdgeInspector, NodeInspector, WorkflowInspector } from './workflow-editor-inspectors';
import { WorkflowEditorNodePalette } from './workflow-editor-node-palette';

type InspectorTab = 'node' | 'transition' | 'workflow';

function hasNonSelectionNodeChanges(changes: NodeChange[]): boolean {
  return changes.some(change => change.type !== 'select');
}

function hasNonSelectionEdgeChanges(changes: EdgeChange[]): boolean {
  return changes.some(change => change.type !== 'select');
}

type LegacyMediaQueryList = {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

function subscribeToMediaQueryChanges(mediaQuery: MediaQueryList, listener: () => void): () => void {
  if (typeof mediaQuery.addEventListener === 'function' && typeof mediaQuery.removeEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }

  const legacyMediaQuery = mediaQuery as unknown as LegacyMediaQueryList;
  const legacyListener = listener as (event: MediaQueryListEvent) => void;
  legacyMediaQuery.addListener?.(legacyListener);
  return () => legacyMediaQuery.removeListener?.(legacyListener);
}

function statusBadgeForSaveState(saveState: SaveState): { status: 'running' | 'completed' | 'failed' | 'pending'; label: string } {
  switch (saveState) {
    case 'saving':
      return { status: 'running', label: 'Saving…' };
    case 'saved':
      return { status: 'completed', label: 'Saved' };
    case 'error':
      return { status: 'failed', label: 'Error' };
    default:
      return { status: 'pending', label: 'Draft' };
  }
}

function toReactFlowEdge(edge: DashboardWorkflowDraftEdge): Edge {
  return {
    id: buildWorkflowEdgeId(edge.sourceNodeKey, edge.targetNodeKey, edge.priority),
    source: edge.sourceNodeKey,
    target: edge.targetNodeKey,
    label: edge.auto ? `auto · ${edge.priority}` : `guard · ${edge.priority}`,
    data: edge,
  };
}

type WorkflowEditorPageContentProps = Readonly<{
  initialDraft: DashboardWorkflowDraftTopology;
  providerOptions?: DashboardAgentProviderOption[];
  modelOptions?: DashboardAgentModelOption[];
  bootstrapDraftOnMount?: boolean;
}>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isDraftNodeType(value: unknown): value is DashboardWorkflowDraftNode['nodeType'] {
  return value === 'agent' || value === 'human' || value === 'tool';
}

function isDraftNodePosition(value: unknown): value is DashboardWorkflowDraftNode['position'] {
  if (value === null) {
    return true;
  }

  if (!isObjectRecord(value)) {
    return false;
  }

  return isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isDraftNodePromptTemplate(value: unknown): value is DashboardWorkflowDraftNode['promptTemplate'] {
  if (value === null) {
    return true;
  }

  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.content === 'string' &&
    (value.contentType === 'text' || value.contentType === 'markdown')
  );
}

function isDraftNode(value: unknown): value is DashboardWorkflowDraftNode {
  if (!isObjectRecord(value)) {
    return false;
  }

  const model = (value as { model?: unknown }).model;
  return (
    typeof value.nodeKey === 'string' &&
    typeof value.displayName === 'string' &&
    isDraftNodeType(value.nodeType) &&
    (typeof value.provider === 'string' || value.provider === null) &&
    (model === undefined || typeof model === 'string' || model === null) &&
    isFiniteNumber(value.maxRetries) &&
    Number.isInteger(value.maxRetries) &&
    isFiniteNumber(value.sequenceIndex) &&
    Number.isInteger(value.sequenceIndex) &&
    isDraftNodePosition(value.position) &&
    isDraftNodePromptTemplate(value.promptTemplate)
  );
}

function isDraftEdge(value: unknown): value is DashboardWorkflowDraftEdge {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.sourceNodeKey === 'string' &&
    typeof value.targetNodeKey === 'string' &&
    isFiniteNumber(value.priority) &&
    Number.isInteger(value.priority) &&
    typeof value.auto === 'boolean' &&
    (value.guardExpression === null ||
      (isObjectRecord(value.guardExpression) && !Array.isArray(value.guardExpression)))
  );
}

function isDraftTopology(value: unknown): value is DashboardWorkflowDraftTopology {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (
    typeof value.treeKey !== 'string' ||
    !isPositiveInteger(value.version) ||
    !isNonNegativeInteger(value.draftRevision) ||
    typeof value.name !== 'string' ||
    !isNullableString(value.description) ||
    !isNullableString(value.versionNotes)
  ) {
    return false;
  }

  if (!Array.isArray(value.nodes) || !value.nodes.every(isDraftNode)) {
    return false;
  }

  if (!Array.isArray(value.edges) || !value.edges.every(isDraftEdge)) {
    return false;
  }

  return Array.isArray(value.initialRunnableNodeKeys)
    && value.initialRunnableNodeKeys.every((nodeKey) => typeof nodeKey === 'string');
}

function parseDraftFromBootstrapPayload(payload: unknown): DashboardWorkflowDraftTopology | null {
  if (!isObjectRecord(payload) || !('draft' in payload)) {
    return null;
  }

  const draft = (payload as { draft?: unknown }).draft;
  if (!isDraftTopology(draft)) {
    return null;
  }

  return draft;
}

export function WorkflowEditorPageContent({
  initialDraft,
  providerOptions = [],
  modelOptions = [],
  bootstrapDraftOnMount = false,
}: WorkflowEditorPageContentProps) {
  const [resolvedDraft, setResolvedDraft] = useState<DashboardWorkflowDraftTopology | null>(
    bootstrapDraftOnMount ? null : initialDraft,
  );
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useEffect(() => {
    if (!bootstrapDraftOnMount) {
      setResolvedDraft(initialDraft);
      setBootstrapError(null);
      return;
    }

    let active = true;
    setResolvedDraft(null);
    setBootstrapError(null);

    async function bootstrapDraft(): Promise<void> {
      try {
        const response = await fetch(`/api/dashboard/workflows/${encodeURIComponent(initialDraft.treeKey)}/draft`, {
          method: 'GET',
        });
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          if (active) {
            setBootstrapError(resolveApiError(response.status, json, 'Preparing draft failed'));
          }
          return;
        }

        const draft = parseDraftFromBootstrapPayload(json);
        if (!draft) {
          if (active) {
            setBootstrapError('Preparing draft failed.');
          }
          return;
        }

        if (active) {
          setResolvedDraft(draft);
          setBootstrapError(null);
        }
      } catch (error_) {
        if (active) {
          setBootstrapError(error_ instanceof Error ? error_.message : 'Preparing draft failed.');
        }
      }
    }

    bootstrapDraft().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [bootstrapAttempt, bootstrapDraftOnMount, initialDraft, initialDraft.treeKey]);

  if (!resolvedDraft) {
    return (
      <div className="workflow-editor-shell">
        <Panel title="Preparing draft">
          <p className="meta-text">Creating editable draft version...</p>
          {bootstrapError ? <p className="run-launch-banner--error" role="alert">{bootstrapError}</p> : null}
          <div className="workflow-actions">
            {bootstrapError ? (
              <ActionButton onClick={() => setBootstrapAttempt(attempt => attempt + 1)}>Retry</ActionButton>
            ) : null}
            <ButtonLink href="/workflows">Exit</ButtonLink>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <WorkflowEditorLoadedContent
      initialDraft={resolvedDraft}
      providerOptions={providerOptions}
      modelOptions={modelOptions}
    />
  );
}

function WorkflowEditorLoadedContent({
  initialDraft,
  providerOptions,
  modelOptions,
}: Readonly<{
  initialDraft: DashboardWorkflowDraftTopology;
  providerOptions: DashboardAgentProviderOption[];
  modelOptions: DashboardAgentModelOption[];
}>) {
  const router = useRouter();
  const treeKey = initialDraft.treeKey;
  const version = initialDraft.version;

  const [workflowName, setWorkflowName] = useState(initialDraft.name);
  const [workflowDescription, setWorkflowDescription] = useState(initialDraft.description ?? '');
  const [workflowVersionNotes, setWorkflowVersionNotes] = useState(initialDraft.versionNotes ?? '');
  const [nodes, setNodes] = useState<Node[]>(() => buildReactFlowNodes(initialDraft));
  const [edges, setEdges] = useState<Edge[]>(() => buildReactFlowEdges(initialDraft));
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>('workflow');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [validation, setValidation] = useState<DashboardWorkflowValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [addNodePaletteOpen, setAddNodePaletteOpen] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [pendingConnectionSourceNodeKey, setPendingConnectionSourceNodeKey] = useState<string | null>(null);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    targetType: 'node' | 'edge';
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [publishing, setPublishing] = useState(false);

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const draftNodesForSave = useMemo(() => nodes.map(mapNodeFromReactFlow), [nodes]);
  const draftEdgesForSave = useMemo(() => edges.map(mapEdgeFromReactFlow), [edges]);

  const latestDraftStateRef = useRef<{
    draftRevision: number;
    name: string;
    description: string;
    versionNotes: string;
    nodes: DashboardWorkflowDraftNode[];
    edges: DashboardWorkflowDraftEdge[];
  }>({
    draftRevision: initialDraft.draftRevision,
    name: initialDraft.name,
    description: initialDraft.description ?? '',
    versionNotes: initialDraft.versionNotes ?? '',
    nodes: buildReactFlowNodes(initialDraft).map(mapNodeFromReactFlow),
    edges: buildReactFlowEdges(initialDraft).map(mapEdgeFromReactFlow),
  });

  useEffect(() => {
    latestDraftStateRef.current = {
      draftRevision: latestDraftStateRef.current.draftRevision,
      name: workflowName,
      description: workflowDescription,
      versionNotes: workflowVersionNotes,
      nodes: draftNodesForSave,
      edges: draftEdgesForSave,
    };
  }, [draftEdgesForSave, draftNodesForSave, workflowDescription, workflowName, workflowVersionNotes]);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') {
      setIsCompactViewport(false);
      return;
    }

    const mediaQuery = globalThis.matchMedia('(max-width: 960px)');
    const update = () => {
      setIsCompactViewport(mediaQuery.matches);
      if (!mediaQuery.matches) {
        setInspectorDrawerOpen(false);
      }
    };

    update();
    return subscribeToMediaQueryChanges(mediaQuery, update);
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeContextMenu = () => setContextMenu(null);
    globalThis.addEventListener('click', closeContextMenu);
    globalThis.addEventListener('contextmenu', closeContextMenu);
    return () => {
      globalThis.removeEventListener('click', closeContextMenu);
      globalThis.removeEventListener('contextmenu', closeContextMenu);
    };
  }, [contextMenu]);

  const { flushSave, markDirty, saveError, saveNow, saveState, scheduleSave } = useDraftAutosave({
    treeKey,
    version,
    latestDraftStateRef,
  });

  const snapshot = useMemo<WorkflowSnapshot>(() => {
    return {
      name: workflowName,
      description: workflowDescription,
      versionNotes: workflowVersionNotes,
      nodes,
      edges,
    };
  }, [edges, nodes, workflowDescription, workflowName, workflowVersionNotes]);

  const applySnapshot = useCallback((next: WorkflowSnapshot) => {
    setWorkflowName(next.name);
    setWorkflowDescription(next.description);
    setWorkflowVersionNotes(next.versionNotes);
    setNodes(next.nodes);
    setEdges(next.edges);
    selectedNodeIdRef.current = null;
    selectedEdgeIdRef.current = null;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setActiveTab('workflow');
  }, []);

  const { redo, scheduleHistoryCommit, undo } = useWorkflowHistory({
    snapshot,
    applySnapshot,
    markDirty,
    scheduleSave,
  });

  const markWorkflowChanged = useCallback(() => {
    markDirty();
    scheduleSave();
    scheduleHistoryCommit();
  }, [markDirty, scheduleHistoryCommit, scheduleSave]);

  const addNodePaletteOpenRef = useRef(addNodePaletteOpen);
  useEffect(() => {
    addNodePaletteOpenRef.current = addNodePaletteOpen;
  }, [addNodePaletteOpen]);

  const selectedNodeIdRef = useRef(selectedNodeId);
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  const selectedEdgeIdRef = useRef(selectedEdgeId);
  useEffect(() => {
    selectedEdgeIdRef.current = selectedEdgeId;
  }, [selectedEdgeId]);

  const edgesRef = useRef(edges);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const openPalette = useCallback((sourceNodeKey?: string) => {
    setPendingConnectionSourceNodeKey(sourceNodeKey ?? null);
    addNodePaletteOpenRef.current = true;
    setAddNodePaletteOpen(true);
  }, [addNodePaletteOpenRef]);

  const closePalette = useCallback(() => {
    setPendingConnectionSourceNodeKey(null);
    addNodePaletteOpenRef.current = false;
    setAddNodePaletteOpen(false);
  }, [addNodePaletteOpenRef]);

  const deleteEdgeById = useCallback((edgeId: string) => {
    setContextMenu((current) => (current?.id === edgeId ? null : current));
    setEdges((current) => current.filter(edge => edge.id !== edgeId));
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    markWorkflowChanged();
  }, [markWorkflowChanged]);

  const deleteNodeById = useCallback((nodeId: string) => {
    setContextMenu((current) => (current?.id === nodeId ? null : current));
    setEdges((current) => current.filter(edge => edge.source !== nodeId && edge.target !== nodeId));
    setNodes((current) => current.filter(node => node.id !== nodeId));
    selectedNodeIdRef.current = null;
    selectedEdgeIdRef.current = null;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setActiveTab('workflow');
    markWorkflowChanged();
  }, [markWorkflowChanged]);

  useWorkflowKeyboardShortcuts({
    addNodePaletteOpenRef,
    selectedNodeIdRef,
    selectedEdgeIdRef,
    edgesRef,
    closePalette,
    openPalette,
    undo,
    redo,
    deleteEdgeById,
    deleteNodeById,
  });

  const initialRunnableNodeKeys = useMemo(() => {
    const incoming = new Set(draftEdgesForSave.map(edge => edge.targetNodeKey));
    return draftNodesForSave.filter(node => !incoming.has(node.nodeKey)).map(node => node.nodeKey);
  }, [draftEdgesForSave, draftNodesForSave]);

  const liveWarnings = useMemo(() => {
    return computeWorkflowLiveWarnings(draftNodesForSave, draftEdgesForSave);
  }, [draftEdgesForSave, draftNodesForSave]);

  const publishSummary = useMemo(() => {
    const previousPublishedVersion = version > 1 ? version - 1 : null;
    const versionBump = previousPublishedVersion === null ? `new → v${version}` : `v${previousPublishedVersion} → v${version}`;
    const versionNotes = workflowVersionNotes.trim();
    return {
      versionBump,
      nodeCount: draftNodesForSave.length,
      edgeCount: draftEdgesForSave.length,
      versionNotes: versionNotes.length > 0 ? versionNotes : 'None',
    };
  }, [draftEdgesForSave.length, draftNodesForSave.length, version, workflowVersionNotes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const shouldMarkDirty = hasNonSelectionNodeChanges(changes);
    setNodes((current) => applyNodeChanges(changes, current));
    if (shouldMarkDirty) {
      markWorkflowChanged();
    }
  }, [markWorkflowChanged]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const shouldMarkDirty = hasNonSelectionEdgeChanges(changes);
    setEdges((current) => applyEdgeChanges(changes, current));
    if (shouldMarkDirty) {
      markWorkflowChanged();
    }
  }, [markWorkflowChanged]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source) {
      return;
    }

    if (!connection.target) {
      openPalette(connection.source);
      return;
    }

    setEdges((current) => {
      const draftEdges = current.map(mapEdgeFromReactFlow);
      const next = createConnectedDraftEdge({
        sourceNodeKey: connection.source,
        targetNodeKey: connection.target,
        existingEdges: draftEdges,
      });
      return [...current, toReactFlowEdge(next)];
    });

    markWorkflowChanged();
  }, [markWorkflowChanged, openPalette]);

  const handleSelectionChange = useCallback((params: { nodes: Node[]; edges: Edge[] }) => {
    const nextNode = params.nodes[0]?.id ?? null;
    const nextEdge = params.edges[0]?.id ?? null;
    setContextMenu(null);
    selectedNodeIdRef.current = nextNode;
    selectedEdgeIdRef.current = nextEdge;
    setSelectedNodeId(nextNode);
    setSelectedEdgeId(nextEdge);

    if (nextNode) {
      setActiveTab('node');
      if (isCompactViewport) {
        setInspectorDrawerOpen(true);
      }
    } else if (nextEdge) {
      setActiveTab('transition');
      if (isCompactViewport) {
        setInspectorDrawerOpen(true);
      }
    }
  }, [isCompactViewport]);

  const addNode = useCallback((args: {
    nodeType: DashboardWorkflowDraftNode['nodeType'];
    position?: { x: number; y: number };
    connectFromNodeKey?: string;
    presetNode?: DashboardWorkflowDraftNode;
  }): DashboardWorkflowDraftNode => {
    const existingKeys = new Set(nodes.map(node => node.id));
    const lastNode = nodes.at(-1)?.data as DashboardWorkflowDraftNode | undefined;
    const nextSequenceIndex = (lastNode?.sequenceIndex ?? 0) + 10;
    const fallbackPosition = { x: 80, y: 80 + nodes.length * 60 };

    const newNode =
      args.presetNode ??
      createDraftNode({
        nodeType: args.nodeType,
        existingNodeKeys: existingKeys,
        nextSequenceIndex,
        position: args.position ?? fallbackPosition,
      });

    setNodes((current) => [
      ...current,
      {
        id: newNode.nodeKey,
        position: newNode.position ?? { x: 0, y: 0 },
        data: toReactFlowNodeData(newNode),
        type: 'default',
      },
    ]);

    if (args.connectFromNodeKey) {
      setEdges((current) => {
        const draftEdges = current.map(mapEdgeFromReactFlow);
        const nextEdge = createConnectedDraftEdge({
          sourceNodeKey: args.connectFromNodeKey as string,
          targetNodeKey: newNode.nodeKey,
          existingEdges: draftEdges,
        });
        return [...current, toReactFlowEdge(nextEdge)];
      });
    }

    selectedNodeIdRef.current = newNode.nodeKey;
    selectedEdgeIdRef.current = null;
    setSelectedNodeId(newNode.nodeKey);
    setSelectedEdgeId(null);
    setActiveTab('node');
    if (isCompactViewport) {
      setInspectorDrawerOpen(true);
    }
    markWorkflowChanged();
    return newNode;
  }, [isCompactViewport, markWorkflowChanged, nodes]);

  const handlePaletteSelect = useCallback((nodeType: DashboardWorkflowDraftNode['nodeType']) => {
    const sourceNodeKey = pendingConnectionSourceNodeKey;
    closePalette();
    addNode({ nodeType, connectFromNodeKey: sourceNodeKey ?? undefined });
  }, [addNode, closePalette, pendingConnectionSourceNodeKey]);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData('application/alphred-workflow-node');
    if (!nodeType) {
      return;
    }

    if (!reactFlowInstance) {
      return;
    }

    const position = toFlowPosition(reactFlowInstance, { x: event.clientX, y: event.clientY });
    if (!position) {
      return;
    }

    addNode({ nodeType: nodeType as DashboardWorkflowDraftNode['nodeType'], position });
  }, [addNode, reactFlowInstance]);

  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    selectedNodeIdRef.current = node.id;
    selectedEdgeIdRef.current = null;
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setActiveTab('node');
    setContextMenu({
      targetType: 'node',
      id: node.id,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const onEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: Edge) => {
    event.preventDefault();
    selectedNodeIdRef.current = null;
    selectedEdgeIdRef.current = edge.id;
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
    setActiveTab('transition');
    setContextMenu({
      targetType: 'edge',
      id: edge.id,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const renameNodeFromContextMenu = useCallback(() => {
    if (contextMenu?.targetType !== 'node') {
      return;
    }

    const target = nodes.find((node) => node.id === contextMenu.id);
    if (!target) {
      setContextMenu(null);
      return;
    }

    const data = target.data as DashboardWorkflowDraftNode;
    const nextDisplayName = globalThis.prompt('Rename node', data.displayName)?.trim();
    if (!nextDisplayName) {
      setContextMenu(null);
      return;
    }

    setNodes((current) => current.map((node) => {
      if (node.id !== contextMenu.id) {
        return node;
      }
      return {
        ...node,
        data: toReactFlowNodeData({
          ...data,
          displayName: nextDisplayName,
        }),
      };
    }));
    setContextMenu(null);
    markWorkflowChanged();
  }, [contextMenu, markWorkflowChanged, nodes]);

  const duplicateNodeFromContextMenu = useCallback(() => {
    if (contextMenu?.targetType !== 'node') {
      return;
    }

    const target = nodes.find((node) => node.id === contextMenu.id);
    if (!target) {
      setContextMenu(null);
      return;
    }

    const sourceNode = target.data as DashboardWorkflowDraftNode;
    const maxSequenceIndex = nodes.reduce((maxValue, node) => {
      const value = (node.data as DashboardWorkflowDraftNode).sequenceIndex;
      return Math.max(maxValue, value);
    }, 0);
    const duplicated = duplicateDraftNode({
      sourceNode,
      existingNodeKeys: new Set(nodes.map((node) => node.id)),
      nextSequenceIndex: maxSequenceIndex + 10,
    });

    addNode({
      nodeType: duplicated.nodeType,
      presetNode: duplicated,
    });
    setContextMenu(null);
  }, [addNode, contextMenu, nodes]);

  const addConnectedNodeFromContextMenu = useCallback(() => {
    if (contextMenu?.targetType !== 'node') {
      return;
    }

    setContextMenu(null);
    openPalette(contextMenu.id);
  }, [contextMenu, openPalette]);

  const duplicateEdgeFromContextMenu = useCallback(() => {
    if (contextMenu?.targetType !== 'edge') {
      return;
    }

    const sourceEdge = edges.find((edge) => edge.id === contextMenu.id);
    if (!sourceEdge) {
      setContextMenu(null);
      return;
    }

    const sourceData = sourceEdge.data as DashboardWorkflowDraftEdge;
    setEdges((current) => {
      const sourceEdges = current.map(mapEdgeFromReactFlow);
      const priority = sourceEdges
        .filter((edge) => edge.sourceNodeKey === sourceEdge.source)
        .reduce((maxValue, edge) => Math.max(maxValue, edge.priority), 90) + 10;
      const nextEdge: DashboardWorkflowDraftEdge = {
        ...sourceData,
        sourceNodeKey: sourceEdge.source,
        targetNodeKey: sourceEdge.target,
        priority,
      };
      return [...current, toReactFlowEdge(nextEdge)];
    });
    setContextMenu(null);
    markWorkflowChanged();
  }, [contextMenu, edges, markWorkflowChanged]);

  async function runValidation(): Promise<void> {
    setValidationError(null);
    setPublishError(null);

    try {
      const saveSucceeded = await flushSave();
      if (!saveSucceeded) {
        setValidationError('Save the latest draft changes before validating.');
        return;
      }

      const response = await fetch(
        `/api/dashboard/workflows/${encodeURIComponent(treeKey)}/draft/validate?version=${version}`,
        { method: 'POST' },
      );
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setValidationError(resolveApiError(response.status, json, 'Validation failed'));
        return;
      }

      setValidation((json as { result: DashboardWorkflowValidationResult }).result);
      setActiveTab('workflow');
    } catch (error_) {
      setValidationError(error_ instanceof Error ? error_.message : 'Validation failed.');
    }
  }

  function openPublishConfirm(): void {
    setPublishError(null);
    setPublishConfirmOpen(true);
  }

  function closePublishConfirm(): void {
    if (publishing) {
      return;
    }
    setPublishConfirmOpen(false);
  }

  async function publish(): Promise<void> {
    setPublishError(null);
    setPublishing(true);

    try {
      const saveSucceeded = await flushSave();
      if (!saveSucceeded) {
        setPublishError('Save the latest draft changes before publishing.');
        return;
      }

      const versionNotes = workflowVersionNotes.trim();
      const response = await fetch(
        `/api/dashboard/workflows/${encodeURIComponent(treeKey)}/draft/publish?version=${version}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(versionNotes.length > 0 ? { versionNotes } : {}),
        },
      );
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setPublishError(resolveApiError(response.status, json, 'Publish failed'));
        return;
      }

      setPublishConfirmOpen(false);
      router.push(`/workflows/${encodeURIComponent(treeKey)}`);
    } catch (error_) {
      setPublishError(error_ instanceof Error ? error_.message : 'Publish failed.');
    } finally {
      setPublishing(false);
    }
  }

  function openInspectorDrawer(): void {
    setInspectorDrawerOpen(true);
  }

  function closeInspectorDrawer(): void {
    setInspectorDrawerOpen(false);
  }

  const statusBadge = useMemo(() => statusBadgeForSaveState(saveState), [saveState]);

  const inspector = (
    <aside
      className={`workflow-editor-inspector${inspectorDrawerOpen ? ' workflow-editor-inspector--open' : ''}`}
      aria-label="Workflow inspector"
    >
      <div className="workflow-editor-inspector__mobile-header">
        <p className="meta-text">Inspector</p>
        <ActionButton className="workflow-editor-inspector-close" onClick={closeInspectorDrawer}>Close</ActionButton>
      </div>
      <nav className="workflow-editor-tabs" aria-label="Inspector tabs">
        <button type="button" className={activeTab === 'node' ? 'active' : ''} onClick={() => setActiveTab('node')} disabled={!selectedNode}>
          Node
        </button>
        <button type="button" className={activeTab === 'transition' ? 'active' : ''} onClick={() => setActiveTab('transition')} disabled={!selectedEdge}>
          Transition
        </button>
        <button type="button" className={activeTab === 'workflow' ? 'active' : ''} onClick={() => setActiveTab('workflow')}>
          Workflow
        </button>
      </nav>

      <div className="workflow-editor-inspector__body">
        {activeTab === 'node' ? (
          <NodeInspector
            node={selectedNode}
            providerOptions={providerOptions}
            modelOptions={modelOptions}
            onAddConnectedNode={(nodeKey) => openPalette(nodeKey)}
            onChange={(next) => {
              if (!selectedNode) return;
              setNodes((current) =>
                current.map((node) =>
                  node.id === selectedNode.id
                    ? {
                        ...node,
                        data: toReactFlowNodeData(next),
                      }
                    : node,
                ),
              );
              markWorkflowChanged();
            }}
          />
        ) : null}

        {activeTab === 'transition' ? (
          <EdgeInspector
            edge={selectedEdge}
            onChange={(next) => {
              if (!selectedEdge) return;
              const nextSelectedEdgeId = buildWorkflowEdgeId(selectedEdge.source, selectedEdge.target, next.priority);
              const label = next.auto ? `auto · ${next.priority}` : `guard · ${next.priority}`;
              setEdges((current) =>
                current.map((edge) =>
                  edge.id === selectedEdge.id
                    ? {
                        ...edge,
                        id: nextSelectedEdgeId,
                        label,
                        data: next,
                      }
                    : edge,
                ),
              );
              if (nextSelectedEdgeId !== selectedEdge.id) {
                selectedEdgeIdRef.current = nextSelectedEdgeId;
                setSelectedEdgeId(nextSelectedEdgeId);
              }
              markWorkflowChanged();
            }}
          />
        ) : null}

        {activeTab === 'workflow' ? (
          <WorkflowInspector
            name={workflowName}
            description={workflowDescription}
            versionNotes={workflowVersionNotes}
            onNameChange={(next) => {
              setWorkflowName(next);
              markWorkflowChanged();
            }}
            onDescriptionChange={(next) => {
              setWorkflowDescription(next);
              markWorkflowChanged();
            }}
            onVersionNotesChange={(next) => {
              setWorkflowVersionNotes(next);
              markWorkflowChanged();
            }}
            initialRunnableNodeKeys={validation?.initialRunnableNodeKeys ?? initialRunnableNodeKeys}
            validation={validation}
            liveWarnings={liveWarnings}
            validationError={validationError}
            publishError={publishError}
          />
        ) : null}
      </div>
    </aside>
  );

  return (
    <div className={`workflow-editor-shell${inspectorDrawerOpen ? ' workflow-editor-shell--drawer-open' : ''}`}>
      <WorkflowEditorAddNodeDialog open={addNodePaletteOpen} onClose={closePalette} onSelect={handlePaletteSelect} />

      {publishConfirmOpen ? (
        <div className="workflow-overlay">
          <button
            type="button"
            aria-label="Close publish workflow dialog"
            tabIndex={-1}
            onClick={closePublishConfirm}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'transparent',
              border: 0,
              padding: 0,
            }}
          />
          <dialog
            open
            className="workflow-dialog"
            aria-modal="true"
            aria-labelledby="workflow-publish-dialog-title"
            onCancel={(event) => {
              event.preventDefault();
              closePublishConfirm();
            }}
            style={{ position: 'relative' }}
          >
            <header className="workflow-dialog__header">
              <h3 id="workflow-publish-dialog-title">Confirm publish</h3>
              <p className="meta-text">Review this summary before publishing the workflow draft.</p>
            </header>

            <div className="workflow-dialog__form">
              <ul className="entity-list">
                <li>
                  <span>Version bump</span>
                  <span>{publishSummary.versionBump}</span>
                </li>
                <li>
                  <span>Nodes</span>
                  <span>{publishSummary.nodeCount}</span>
                </li>
                <li>
                  <span>Transitions</span>
                  <span>{publishSummary.edgeCount}</span>
                </li>
                <li>
                  <span>Version notes</span>
                  <span>{publishSummary.versionNotes}</span>
                </li>
              </ul>

              {publishError ? <p className="run-launch-banner--error" role="alert">{publishError}</p> : null}

              <div className="workflow-dialog__actions">
                <ActionButton onClick={closePublishConfirm} disabled={publishing}>
                  Cancel
                </ActionButton>
                <ActionButton tone="primary" onClick={() => publish().catch(() => undefined)} disabled={publishing}>
                  {publishing ? 'Publishing...' : 'Publish version'}
                </ActionButton>
              </div>
            </div>
          </dialog>
        </div>
      ) : null}

      {isCompactViewport && inspectorDrawerOpen ? (
        <button
          type="button"
          className="workflow-editor-inspector-backdrop"
          aria-label="Close inspector drawer"
          onClick={closeInspectorDrawer}
        />
      ) : null}

      {contextMenu ? (
        <div
          className="workflow-context-menu"
          role="menu"
          aria-label={`${contextMenu.targetType} context menu`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.targetType === 'node' ? (
            <>
              <button type="button" role="menuitem" onClick={renameNodeFromContextMenu}>Rename</button>
              <button type="button" role="menuitem" onClick={duplicateNodeFromContextMenu}>Duplicate</button>
              <button type="button" role="menuitem" onClick={addConnectedNodeFromContextMenu}>Add connected node</button>
              <button type="button" role="menuitem" onClick={() => deleteNodeById(contextMenu.id)}>Delete</button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={duplicateEdgeFromContextMenu}>Duplicate</button>
              <button type="button" role="menuitem" onClick={() => deleteEdgeById(contextMenu.id)}>Delete</button>
            </>
          )}
        </div>
      ) : null}

      <header className="workflow-editor-topbar">
        <div className="workflow-editor-topbar__meta">
          <p className="meta-text">Workflows / {treeKey}</p>
          <h2>{workflowName}</h2>
        </div>
        <div className="workflow-editor-topbar__actions">
          <StatusBadge status={statusBadge.status} label={statusBadge.label} />
          <ActionButton onClick={undo}>Undo</ActionButton>
          <ActionButton onClick={redo}>Redo</ActionButton>
          <ActionButton onClick={runValidation}>Validate</ActionButton>
          <ActionButton className="workflow-editor-inspector-toggle" onClick={openInspectorDrawer}>Inspector</ActionButton>
          <ActionButton tone="primary" onClick={openPublishConfirm}>Publish</ActionButton>
          <ButtonLink href="/workflows">Exit</ButtonLink>
        </div>
      </header>

      <div className="workflow-editor-body">
        <aside className="workflow-editor-palette" aria-label="Node palette">
          <WorkflowEditorNodePalette onAdd={(nodeType) => addNode({ nodeType })} />

          <Panel title="Draft version">
            <p className="meta-text">v{version} (unpublished)</p>
            {saveError ? <p className="run-launch-banner--error" role="alert">{saveError}</p> : null}
            {saveState === 'error' ? (
              <ActionButton onClick={() => saveNow().catch(() => undefined)}>
                Retry save
              </ActionButton>
            ) : null}
          </Panel>
        </aside>

        <section className="workflow-editor-canvas" aria-label="Workflow canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={handleSelectionChange}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onPaneClick={() => setContextMenu(null)}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            fitView
          >
            <Background />
            <MiniMap />
            <Controls />
          </ReactFlow>
        </section>

        {inspector}
      </div>
    </div>
  );
}
