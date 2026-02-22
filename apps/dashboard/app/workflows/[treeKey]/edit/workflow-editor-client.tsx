'use client';

import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type DragEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
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
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Panel, StatusBadge } from '../../../ui/primitives';
import { resolveApiError } from '../../workflows-shared';
import { WorkflowEditorAddNodeDialog } from './workflow-editor-add-node-dialog';
import {
  buildReactFlowEdges,
  buildReactFlowNodes,
  createDraftNode,
  mapEdgeFromReactFlow,
  mapNodeFromReactFlow,
  nextPriorityForSource,
  toFlowPosition,
} from './workflow-editor-helpers';
import {
  useDraftAutosave,
  useWorkflowHistory,
  useWorkflowKeyboardShortcuts,
  type WorkflowSnapshot,
} from './workflow-editor-hooks';
import { EdgeInspector, NodeInspector, WorkflowInspector } from './workflow-editor-inspectors';
import { WorkflowEditorNodePalette } from './workflow-editor-node-palette';

type InspectorTab = 'node' | 'transition' | 'workflow';

export function WorkflowEditorPageContent({ initialDraft }: Readonly<{ initialDraft: DashboardWorkflowDraftTopology }>) {
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

  const { markDirty, saveError, saveNow, saveState, scheduleSave } = useDraftAutosave({
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

  const openPalette = useCallback(() => {
    addNodePaletteOpenRef.current = true;
    setAddNodePaletteOpen(true);
  }, [addNodePaletteOpenRef]);

  const closePalette = useCallback(() => {
    addNodePaletteOpenRef.current = false;
    setAddNodePaletteOpen(false);
  }, [addNodePaletteOpenRef]);

  const deleteEdgeById = useCallback((edgeId: string) => {
    setEdges((current) => current.filter(edge => edge.id !== edgeId));
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    markWorkflowChanged();
  }, [markWorkflowChanged]);

  const deleteNodeById = useCallback((nodeId: string) => {
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

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    markWorkflowChanged();
  }, [markWorkflowChanged]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    markWorkflowChanged();
  }, [markWorkflowChanged]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }

    setEdges((current) => {
      const draftEdges = current.map(mapEdgeFromReactFlow);
      const priority = nextPriorityForSource(draftEdges, connection.source);
      const next: Edge = {
        id: `${connection.source}->${connection.target}:${priority}`,
        source: connection.source,
        target: connection.target,
        label: `auto · ${priority}`,
        data: {
          sourceNodeKey: connection.source,
          targetNodeKey: connection.target,
          priority,
          auto: true,
          guardExpression: null,
        } satisfies DashboardWorkflowDraftEdge,
      };
      return addEdge(next, current);
    });

    markWorkflowChanged();
  }, [markWorkflowChanged]);

  const handleSelectionChange = useCallback((params: { nodes: Node[]; edges: Edge[] }) => {
    const nextNode = params.nodes[0]?.id ?? null;
    const nextEdge = params.edges[0]?.id ?? null;
    selectedNodeIdRef.current = nextNode;
    selectedEdgeIdRef.current = nextEdge;
    setSelectedNodeId(nextNode);
    setSelectedEdgeId(nextEdge);

    if (nextNode) {
      setActiveTab('node');
    } else if (nextEdge) {
      setActiveTab('transition');
    }
  }, []);

  const addNode = useCallback((args: {
    nodeType: DashboardWorkflowDraftNode['nodeType'];
    position?: { x: number; y: number };
  }) => {
    const existingKeys = new Set(nodes.map(node => node.id));
    const lastNode = nodes.at(-1)?.data as DashboardWorkflowDraftNode | undefined;
    const nextSequenceIndex = (lastNode?.sequenceIndex ?? 0) + 10;
    const fallbackPosition = { x: 80, y: 80 + nodes.length * 60 };

    const newNode = createDraftNode({
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
        data: newNode,
      },
    ]);

    selectedNodeIdRef.current = newNode.nodeKey;
    selectedEdgeIdRef.current = null;
    setSelectedNodeId(newNode.nodeKey);
    setSelectedEdgeId(null);
    setActiveTab('node');
    markWorkflowChanged();
  }, [markWorkflowChanged, nodes]);

  const handlePaletteSelect = useCallback((nodeType: DashboardWorkflowDraftNode['nodeType']) => {
    closePalette();
    addNode({ nodeType });
  }, [addNode, closePalette]);

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

  async function runValidation(): Promise<void> {
    setValidationError(null);
    setPublishError(null);

    try {
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

  async function publish(): Promise<void> {
    setPublishError(null);

    try {
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

      router.push(`/workflows/${encodeURIComponent(treeKey)}`);
    } catch (error_) {
      setPublishError(error_ instanceof Error ? error_.message : 'Publish failed.');
    }
  }

  const statusBadge = useMemo(() => {
    switch (saveState) {
      case 'saving':
        return { status: 'running' as const, label: 'Saving…' };
      case 'saved':
        return { status: 'completed' as const, label: 'Saved' };
      case 'error':
        return { status: 'failed' as const, label: 'Error' };
      default:
        return { status: 'pending' as const, label: 'Draft' };
    }
  }, [saveState]);

  const inspector = (
    <aside className="workflow-editor-inspector" aria-label="Workflow inspector">
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
            onChange={(next) => {
              if (!selectedNode) return;
              setNodes((current) =>
                current.map((node) => (node.id === selectedNode.id ? { ...node, data: next } : node)),
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
              const label = next.auto ? `auto · ${next.priority}` : `guard · ${next.priority}`;
              setEdges((current) =>
                current.map((edge) =>
                  edge.id === selectedEdge.id
                    ? {
                        ...edge,
                        label,
                        data: next,
                      }
                    : edge,
                ),
              );
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
            validationError={validationError}
            publishError={publishError}
          />
        ) : null}
      </div>
    </aside>
  );

	return (
	    <div className="workflow-editor-shell">
	      <WorkflowEditorAddNodeDialog open={addNodePaletteOpen} onClose={closePalette} onSelect={handlePaletteSelect} />
	      <header className="workflow-editor-topbar">
	        <div className="workflow-editor-topbar__meta">
	          <p className="meta-text">Workflows / {treeKey}</p>
	          <h2>{workflowName}</h2>
	        </div>
        <div className="workflow-editor-topbar__actions">
          <StatusBadge status={statusBadge.status} label={statusBadge.label} />
          <ActionButton onClick={runValidation}>Validate</ActionButton>
          <ActionButton tone="primary" onClick={publish}>Publish</ActionButton>
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
