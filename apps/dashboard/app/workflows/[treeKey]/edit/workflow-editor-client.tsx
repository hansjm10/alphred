'use client';

import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
  DashboardSaveWorkflowDraftRequest,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../../ui/primitives';

type SaveState = 'draft' | 'saving' | 'saved' | 'error';
type InspectorTab = 'node' | 'transition' | 'workflow';
type WorkflowSnapshot = Readonly<{
  name: string;
  description: string;
  nodes: Node[];
  edges: Edge[];
}>;

type ApiErrorEnvelope = {
  error?: {
    message?: string;
  };
};

type FlowPoint = Readonly<{ x: number; y: number }>;

function toFlowPosition(instance: ReactFlowInstance, point: FlowPoint): FlowPoint | null {
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

function slugifyNodeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function resolveApiError(status: number, payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ApiErrorEnvelope).error === 'object' &&
    (payload as ApiErrorEnvelope).error !== null &&
    typeof (payload as ApiErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ApiErrorEnvelope).error?.message as string;
  }

  return `${fallback} (HTTP ${status}).`;
}

function nextPriorityForSource(edges: readonly DashboardWorkflowDraftEdge[], sourceNodeKey: string): number {
  const priorities = edges
    .filter(edge => edge.sourceNodeKey === sourceNodeKey)
    .map(edge => edge.priority);

  if (priorities.length === 0) {
    return 100;
  }

  return Math.max(...priorities) + 10;
}

function buildReactFlowNodes(draft: DashboardWorkflowDraftTopology): Node[] {
  return draft.nodes.map(node => ({
    id: node.nodeKey,
    position: node.position ?? { x: 0, y: 0 },
    data: {
      ...node,
    },
    type: 'default',
  }));
}

function buildReactFlowEdges(draft: DashboardWorkflowDraftTopology): Edge[] {
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

function mapNodeFromReactFlow(node: Node): DashboardWorkflowDraftNode {
  const data = node.data as DashboardWorkflowDraftNode;
  return {
    ...data,
    nodeKey: data.nodeKey,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
  };
}

function mapEdgeFromReactFlow(edge: Edge): DashboardWorkflowDraftEdge {
  const data = edge.data as DashboardWorkflowDraftEdge;
  return {
    sourceNodeKey: edge.source,
    targetNodeKey: edge.target,
    priority: data.priority,
    auto: data.auto,
    guardExpression: data.auto ? null : (data.guardExpression ?? null),
  };
}

export function WorkflowEditorPageContent({ initialDraft }: Readonly<{ initialDraft: DashboardWorkflowDraftTopology }>) {
  const router = useRouter();
  const treeKey = initialDraft.treeKey;
  const version = initialDraft.version;

  const [workflowName, setWorkflowName] = useState(initialDraft.name);
  const [workflowDescription, setWorkflowDescription] = useState(initialDraft.description ?? '');
  const [nodes, setNodes] = useState<Node[]>(() => buildReactFlowNodes(initialDraft));
  const [edges, setEdges] = useState<Edge[]>(() => buildReactFlowEdges(initialDraft));
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('draft');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>('workflow');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [validation, setValidation] = useState<DashboardWorkflowValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const pendingSaveRef = useRef<number | null>(null);
  const pendingHistoryCommitRef = useRef<number | null>(null);
  const workflowHistoryRef = useRef<{
    past: WorkflowSnapshot[];
    present: WorkflowSnapshot;
    future: WorkflowSnapshot[];
  }>({
    past: [],
    present: {
      name: initialDraft.name,
      description: initialDraft.description ?? '',
      nodes: buildReactFlowNodes(initialDraft),
      edges: buildReactFlowEdges(initialDraft),
    },
    future: [],
  });
  const applyingHistoryRef = useRef(false);

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const draftNodesForSave = useMemo(() => nodes.map(mapNodeFromReactFlow), [nodes]);
  const draftEdgesForSave = useMemo(() => edges.map(mapEdgeFromReactFlow), [edges]);

  const initialRunnableNodeKeys = useMemo(() => {
    const incoming = new Set(draftEdgesForSave.map(edge => edge.targetNodeKey));
    return draftNodesForSave.filter(node => !incoming.has(node.nodeKey)).map(node => node.nodeKey);
  }, [draftEdgesForSave, draftNodesForSave]);

  const scheduleSave = useCallback(() => {
    if (pendingSaveRef.current !== null) {
      window.clearTimeout(pendingSaveRef.current);
    }

    pendingSaveRef.current = window.setTimeout(() => {
      pendingSaveRef.current = null;
      void saveDraft();
    }, 1000);
  }, []);

  const scheduleHistoryCommit = useCallback(() => {
    if (applyingHistoryRef.current) {
      return;
    }

    if (pendingHistoryCommitRef.current !== null) {
      window.clearTimeout(pendingHistoryCommitRef.current);
    }

    pendingHistoryCommitRef.current = window.setTimeout(() => {
      pendingHistoryCommitRef.current = null;

      const history = workflowHistoryRef.current;
      history.past = [...history.past, history.present].slice(-50);
      history.present = {
        name: workflowName,
        description: workflowDescription,
        nodes,
        edges,
      };
      history.future = [];
    }, 400);
  }, [edges, nodes, workflowDescription, workflowName]);

  useEffect(() => {
    return () => {
      if (pendingSaveRef.current !== null) {
        window.clearTimeout(pendingSaveRef.current);
      }
      if (pendingHistoryCommitRef.current !== null) {
        window.clearTimeout(pendingHistoryCommitRef.current);
      }
    };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    setSaveState('draft');
    scheduleSave();
    scheduleHistoryCommit();
  }, [scheduleHistoryCommit, scheduleSave]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    setSaveState('draft');
    scheduleSave();
    scheduleHistoryCommit();
  }, [scheduleHistoryCommit, scheduleSave]);

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

    setSaveState('draft');
    scheduleSave();
    scheduleHistoryCommit();
  }, [scheduleHistoryCommit, scheduleSave]);

  const handleSelectionChange = useCallback((params: { nodes: Node[]; edges: Edge[] }) => {
    const nextNode = params.nodes[0]?.id ?? null;
    const nextEdge = params.edges[0]?.id ?? null;
    setSelectedNodeId(nextNode);
    setSelectedEdgeId(nextEdge);

    if (nextNode) {
      setActiveTab('node');
    } else if (nextEdge) {
      setActiveTab('transition');
    }
  }, []);

  const handleAddNode = useCallback((nodeType: DashboardWorkflowDraftNode['nodeType']) => {
    const baseName = nodeType === 'agent' ? 'Agent' : nodeType === 'human' ? 'Human' : 'Tool';
    const keyBase = slugifyNodeKey(baseName) || nodeType;
    const existingKeys = new Set(nodes.map(node => node.id));
    let nodeKey = keyBase;
    let counter = 2;
    while (existingKeys.has(nodeKey)) {
      nodeKey = `${keyBase}-${counter}`;
      counter += 1;
    }

    const sequenceIndex = (draftNodesForSave.at(-1)?.sequenceIndex ?? 0) + 10;

    const newNode: DashboardWorkflowDraftNode = {
      nodeKey,
      displayName: baseName,
      nodeType,
      provider: nodeType === 'agent' ? 'codex' : null,
      maxRetries: 0,
      sequenceIndex,
      position: { x: 80, y: 80 + nodes.length * 60 },
      promptTemplate:
        nodeType === 'agent'
          ? { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' }
          : null,
    };

    setNodes((current) => [
      ...current,
      {
        id: newNode.nodeKey,
        position: newNode.position ?? { x: 0, y: 0 },
        data: newNode,
      },
    ]);

    setSelectedNodeId(newNode.nodeKey);
    setSelectedEdgeId(null);
    setActiveTab('node');
    setSaveState('draft');
    scheduleSave();
    scheduleHistoryCommit();
  }, [draftNodesForSave, nodes, scheduleHistoryCommit, scheduleSave]);

  const handleAddNodeAtPosition = useCallback((
    nodeType: DashboardWorkflowDraftNode['nodeType'],
    position: { x: number; y: number },
  ) => {
    const baseName = nodeType === 'agent' ? 'Agent' : nodeType === 'human' ? 'Human' : 'Tool';
    const keyBase = slugifyNodeKey(baseName) || nodeType;
    const existingKeys = new Set(nodes.map(node => node.id));
    let nodeKey = keyBase;
    let counter = 2;
    while (existingKeys.has(nodeKey)) {
      nodeKey = `${keyBase}-${counter}`;
      counter += 1;
    }

    const sequenceIndex = (draftNodesForSave.at(-1)?.sequenceIndex ?? 0) + 10;

    const newNode: DashboardWorkflowDraftNode = {
      nodeKey,
      displayName: baseName,
      nodeType,
      provider: nodeType === 'agent' ? 'codex' : null,
      maxRetries: 0,
      sequenceIndex,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
      promptTemplate:
        nodeType === 'agent'
          ? { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' }
          : null,
    };

    setNodes((current) => [
      ...current,
      {
        id: newNode.nodeKey,
        position: newNode.position ?? { x: 0, y: 0 },
        data: newNode,
      },
    ]);

    setSelectedNodeId(newNode.nodeKey);
    setSelectedEdgeId(null);
    setActiveTab('node');
    setSaveState('draft');
    scheduleSave();
    scheduleHistoryCommit();
  }, [draftNodesForSave, nodes, scheduleHistoryCommit, scheduleSave]);

  const undo = useCallback(() => {
    const history = workflowHistoryRef.current;
    if (history.past.length === 0) {
      return;
    }

    const previous = history.past[history.past.length - 1];
    const remaining = history.past.slice(0, -1);
    history.past = remaining;
    history.future = [history.present, ...history.future];
    history.present = previous;

    applyingHistoryRef.current = true;
    setWorkflowName(previous.name);
    setWorkflowDescription(previous.description);
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setActiveTab('workflow');
    setSaveState('draft');
    scheduleSave();
    window.setTimeout(() => {
      applyingHistoryRef.current = false;
    }, 0);
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const history = workflowHistoryRef.current;
    if (history.future.length === 0) {
      return;
    }

    const next = history.future[0];
    history.future = history.future.slice(1);
    history.past = [...history.past, history.present].slice(-50);
    history.present = next;

    applyingHistoryRef.current = true;
    setWorkflowName(next.name);
    setWorkflowDescription(next.description);
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setActiveTab('workflow');
    setSaveState('draft');
    scheduleSave();
    window.setTimeout(() => {
      applyingHistoryRef.current = false;
    }, 0);
  }, [scheduleSave]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!target || !(target instanceof HTMLElement)) {
        return false;
      }

      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const isUndo = (event.metaKey || event.ctrlKey) && key === 'z' && !event.shiftKey;
      const isRedo = (event.metaKey || event.ctrlKey) && ((key === 'z' && event.shiftKey) || key === 'y');

      if (isUndo) {
        event.preventDefault();
        undo();
        return;
      }

      if (isRedo) {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedEdgeId) {
          event.preventDefault();
          setEdges((current) => current.filter(edge => edge.id !== selectedEdgeId));
          setSelectedEdgeId(null);
          setSaveState('draft');
          scheduleSave();
          scheduleHistoryCommit();
          return;
        }

        if (selectedNodeId) {
          event.preventDefault();
          const connectedEdges = edges.filter(edge => edge.source === selectedNodeId || edge.target === selectedNodeId);
          const requiresConfirm = connectedEdges.length > 0;
          if (requiresConfirm && !window.confirm('Delete this node and its connected transitions?')) {
            return;
          }

          setEdges((current) => current.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
          setNodes((current) => current.filter(node => node.id !== selectedNodeId));
          setSelectedNodeId(null);
          setSaveState('draft');
          scheduleSave();
          scheduleHistoryCommit();
        }
      }

      if (!event.metaKey && !event.ctrlKey && key === 'n') {
        event.preventDefault();
        handleAddNode('agent');
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    edges,
    handleAddNode,
    redo,
    scheduleHistoryCommit,
    scheduleSave,
    selectedEdgeId,
    selectedNodeId,
    undo,
  ]);

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

    handleAddNodeAtPosition(nodeType as DashboardWorkflowDraftNode['nodeType'], position);
  }, [handleAddNodeAtPosition, reactFlowInstance]);

  async function saveDraft(): Promise<void> {
    setSaveError(null);
    setSaveState('saving');

    const payload: DashboardSaveWorkflowDraftRequest = {
      name: workflowName,
      description: workflowDescription.trim().length > 0 ? workflowDescription : undefined,
      nodes: draftNodesForSave,
      edges: draftEdgesForSave,
    };

    try {
      const response = await fetch(`/api/dashboard/workflows/${encodeURIComponent(treeKey)}/draft?version=${version}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveState('error');
        setSaveError(resolveApiError(response.status, json, 'Autosave failed'));
        return;
      }

      setSaveState('saved');
    } catch (failure) {
      setSaveState('error');
      setSaveError(failure instanceof Error ? failure.message : 'Autosave failed.');
    }
  }

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
    } catch (failure) {
      setValidationError(failure instanceof Error ? failure.message : 'Validation failed.');
    }
  }

  async function publish(): Promise<void> {
    setPublishError(null);

    try {
      const response = await fetch(
        `/api/dashboard/workflows/${encodeURIComponent(treeKey)}/draft/publish?version=${version}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      );
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setPublishError(resolveApiError(response.status, json, 'Publish failed'));
        return;
      }

      router.push(`/workflows/${encodeURIComponent(treeKey)}`);
    } catch (failure) {
      setPublishError(failure instanceof Error ? failure.message : 'Publish failed.');
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
    <div className="workflow-editor-inspector" role="complementary" aria-label="Workflow inspector">
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
              setSaveState('draft');
              scheduleSave();
            }}
          />
        ) : null}

        {activeTab === 'transition' ? (
          <EdgeInspector
            edge={selectedEdge}
            onChange={(next) => {
              if (!selectedEdge) return;
              setEdges((current) =>
                current.map((edge) =>
                  edge.id === selectedEdge.id
                    ? {
                        ...edge,
                        label: next.auto ? `auto · ${next.priority}` : `guard · ${next.priority}`,
                        data: next,
                      }
                    : edge,
                ),
              );
              setSaveState('draft');
              scheduleSave();
            }}
          />
        ) : null}

        {activeTab === 'workflow' ? (
          <WorkflowInspector
            name={workflowName}
            description={workflowDescription}
            onNameChange={(event) => {
              setWorkflowName(event.target.value);
              setSaveState('draft');
              scheduleSave();
            }}
            onDescriptionChange={(event) => {
              setWorkflowDescription(event.target.value);
              setSaveState('draft');
              scheduleSave();
            }}
            initialRunnableNodeKeys={validation?.initialRunnableNodeKeys ?? initialRunnableNodeKeys}
            validation={validation}
            validationError={validationError}
            publishError={publishError}
          />
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="workflow-editor-shell">
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
          <Card title="Node palette" description="Drag onto canvas or click to add.">
            <div className="workflow-palette-draggable-list">
              <div
                className="workflow-palette-draggable"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/alphred-workflow-node', 'agent');
                  event.dataTransfer.effectAllowed = 'move';
                }}
              >
                Agent node
              </div>
              <div
                className="workflow-palette-draggable"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/alphred-workflow-node', 'human');
                  event.dataTransfer.effectAllowed = 'move';
                }}
              >
                Human node
              </div>
              <div
                className="workflow-palette-draggable"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/alphred-workflow-node', 'tool');
                  event.dataTransfer.effectAllowed = 'move';
                }}
              >
                Tool node
              </div>
            </div>

            <div className="workflow-palette-actions">
              <ActionButton onClick={() => handleAddNode('agent')}>Add agent</ActionButton>
              <ActionButton onClick={() => handleAddNode('human')}>Add human</ActionButton>
              <ActionButton onClick={() => handleAddNode('tool')}>Add tool</ActionButton>
            </div>
          </Card>

	          <Panel title="Draft version">
	            <p className="meta-text">v{version} (unpublished)</p>
	            {saveError ? <p className="run-launch-banner--error" role="alert">{saveError}</p> : null}
	            {saveState === 'error' ? (
	              <ActionButton onClick={() => void saveDraft()}>
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

function NodeInspector({
  node,
  onChange,
}: Readonly<{
  node: Node | null;
  onChange: (next: DashboardWorkflowDraftNode) => void;
}>) {
  if (!node) {
    return <p className="meta-text">Select a node to edit details.</p>;
  }

  const data = node.data as DashboardWorkflowDraftNode;

  function handleFieldChange(field: keyof DashboardWorkflowDraftNode, value: unknown) {
    onChange({ ...data, [field]: value } as DashboardWorkflowDraftNode);
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!data.promptTemplate) {
      handleFieldChange('promptTemplate', { content: event.target.value, contentType: 'markdown' });
      return;
    }

    handleFieldChange('promptTemplate', { ...data.promptTemplate, content: event.target.value });
  }

  return (
    <div className="workflow-inspector-stack">
      <h3>Node</h3>
      <label className="workflow-inspector-field">
        <span>Display name</span>
        <input value={data.displayName} onChange={(event) => handleFieldChange('displayName', event.target.value)} />
      </label>

      <label className="workflow-inspector-field">
        <span>Node key</span>
        <input value={data.nodeKey} readOnly aria-readonly="true" />
        <span className="meta-text">Keys are stable IDs used by transitions.</span>
      </label>

      <label className="workflow-inspector-field">
        <span>Node type</span>
        <select value={data.nodeType} onChange={(event) => handleFieldChange('nodeType', event.target.value)}>
          <option value="agent">agent</option>
          <option value="human">human</option>
          <option value="tool">tool</option>
        </select>
      </label>

      {data.nodeType === 'agent' ? (
        <>
          <label className="workflow-inspector-field">
            <span>Provider</span>
            <select value={data.provider ?? 'codex'} onChange={(event) => handleFieldChange('provider', event.target.value)}>
              <option value="codex">codex</option>
              <option value="claude">claude</option>
            </select>
          </label>

          <label className="workflow-inspector-field">
            <span>Prompt</span>
            <textarea value={data.promptTemplate?.content ?? ''} rows={10} onChange={handlePromptChange} />
          </label>
        </>
      ) : (
        <p className="meta-text">Human/tool nodes are supported as draft placeholders; publishing may be blocked by validation.</p>
      )}

      <label className="workflow-inspector-field">
        <span>Max retries</span>
        <input
          type="number"
          min={0}
          value={data.maxRetries}
          onChange={(event) => handleFieldChange('maxRetries', Number(event.target.value))}
        />
      </label>
    </div>
  );
}

function EdgeInspector({
  edge,
  onChange,
}: Readonly<{
  edge: Edge | null;
  onChange: (next: DashboardWorkflowDraftEdge) => void;
}>) {
  if (!edge) {
    return <p className="meta-text">Select a transition to edit details.</p>;
  }

  const data = edge.data as DashboardWorkflowDraftEdge;

  function readGuardDecisionValue(expression: unknown): string {
    if (!expression || typeof expression !== 'object') {
      return 'approved';
    }

    if (!('value' in expression)) {
      return 'approved';
    }

    const value = (expression as { value?: unknown }).value;
    return typeof value === 'string' ? value : 'approved';
  }

  function handleAutoChange(nextAuto: boolean) {
    if (nextAuto) {
      onChange({ ...data, auto: true, guardExpression: null });
      return;
    }

    onChange({
      ...data,
      auto: false,
      guardExpression: data.guardExpression ?? { field: 'decision', operator: '==', value: 'approved' },
    });
  }

  function handleGuardValueChange(nextValue: string) {
    onChange({
      ...data,
      auto: false,
      guardExpression: { field: 'decision', operator: '==', value: nextValue },
    });
  }

  return (
    <div className="workflow-inspector-stack">
      <h3>Transition</h3>
      <p className="meta-text">{edge.source} → {edge.target}</p>

      <label className="workflow-inspector-field">
        <span>Priority</span>
        <input
          type="number"
          min={0}
          value={data.priority}
          onChange={(event) => onChange({ ...data, priority: Number(event.target.value) })}
        />
      </label>

      <label className="workflow-inspector-field workflow-inspector-field--inline">
        <span>Auto</span>
        <input type="checkbox" checked={data.auto} onChange={(event) => handleAutoChange(event.target.checked)} />
      </label>

      {!data.auto ? (
        <label className="workflow-inspector-field">
          <span>Guard (decision)</span>
          <select
            value={readGuardDecisionValue(data.guardExpression)}
            onChange={(event) => handleGuardValueChange(event.target.value)}
          >
            <option value="approved">approved</option>
            <option value="changes_requested">changes_requested</option>
            <option value="blocked">blocked</option>
            <option value="retry">retry</option>
          </select>
        </label>
      ) : (
        <p className="meta-text">Auto transitions are unconditional.</p>
      )}
    </div>
  );
}

function WorkflowInspector({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  initialRunnableNodeKeys,
  validation,
  validationError,
  publishError,
}: Readonly<{
  name: string;
  description: string;
  onNameChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDescriptionChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  initialRunnableNodeKeys: readonly string[];
  validation: DashboardWorkflowValidationResult | null;
  validationError: string | null;
  publishError: string | null;
}>) {
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];

  return (
    <div className="workflow-inspector-stack">
      <h3>Workflow</h3>
      <label className="workflow-inspector-field">
        <span>Name</span>
        <input value={name} onChange={onNameChange} />
      </label>

      <label className="workflow-inspector-field">
        <span>Description</span>
        <textarea rows={3} value={description} onChange={onDescriptionChange} />
      </label>

      <Panel title="Initial runnable nodes">
        {initialRunnableNodeKeys.length === 0 ? (
          <p className="meta-text">None detected.</p>
        ) : (
          <div className="workflow-chip-row">
            {initialRunnableNodeKeys.map((key) => (
              <span key={key} className="workflow-chip">{key}</span>
            ))}
          </div>
        )}
      </Panel>

      {validationError ? <p className="run-launch-banner--error" role="alert">{validationError}</p> : null}
      {publishError ? <p className="run-launch-banner--error" role="alert">{publishError}</p> : null}

      <Panel title="Validation results">
        {validation === null ? (
          <p className="meta-text">Run validation to see publish blockers and warnings.</p>
        ) : errors.length === 0 && warnings.length === 0 ? (
          <p className="meta-text">No issues detected.</p>
        ) : (
          <div className="workflow-validation-stack">
            {errors.length > 0 ? (
              <div>
                <h4>Errors</h4>
                <ul className="workflow-issue-list">
                  {errors.map((issue) => (
                    <li key={`error-${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div>
                <h4>Warnings</h4>
                <ul className="workflow-issue-list">
                  {warnings.map((issue) => (
                    <li key={`warn-${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
