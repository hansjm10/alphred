// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowDraftTopology,
} from '../../../../src/server/dashboard-contracts';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

let latestReactFlowProps: Record<string, unknown> | null = null;
let latestMiniMapProps: Record<string, unknown> | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    MarkerType: {
      ArrowClosed: 'arrowclosed',
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: (props: Record<string, unknown>) => {
      latestMiniMapProps = props;
      return null;
    },
    ReactFlow: (props: { children?: React.ReactNode; onInit?: (instance: unknown) => void }) => {
      latestReactFlowProps = props as unknown as Record<string, unknown>;
      const instance = React.useMemo(() => {
        return {
          screenToFlowPosition: (point: { x: number; y: number }) => point,
          project: (point: { x: number; y: number }) => point,
        };
      }, []);
      React.useEffect(() => {
        props.onInit?.(instance);
      }, [props.onInit, instance]);
      return <div data-testid="reactflow">{props.children}</div>;
    },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    applyEdgeChanges: (_changes: unknown[], edges: unknown[]) => edges,
    applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  };
});

import { WorkflowEditorPageContent } from './workflow-editor-client';

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

function createAgentNode(
  overrides: Partial<DashboardWorkflowDraftNode> = {},
): DashboardWorkflowDraftNode {
  return {
    nodeKey: 'design',
    displayName: 'Design',
    nodeType: 'agent',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    maxRetries: 0,
    sequenceIndex: 10,
    position: { x: 0, y: 0 },
    promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
    ...overrides,
  };
}

function createTransitionEdge(
  overrides: Partial<DashboardWorkflowDraftEdge> = {},
): DashboardWorkflowDraftEdge {
  return {
    sourceNodeKey: 'design',
    targetNodeKey: 'implement',
    priority: 100,
    auto: true,
    guardExpression: null,
    ...overrides,
  };
}

function createInitialDraft(
  overrides: Partial<DashboardWorkflowDraftTopology> = {},
): DashboardWorkflowDraftTopology {
  return {
    treeKey: 'demo-tree',
    version: 1,
    draftRevision: 0,
    name: 'Demo Tree',
    description: null,
    versionNotes: null,
    nodes: [createAgentNode()],
    edges: [],
    initialRunnableNodeKeys: ['design'],
    ...overrides,
  };
}

describe('WorkflowEditorPageContent', () => {
  beforeEach(() => {
    pushMock.mockReset();
    latestReactFlowProps = null;
    latestMiniMapProps = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('autosaves the latest workflow name after the idle timeout', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const init = call[1];
    expect(init).toBeTruthy();
    expect(init?.method).toBe('PUT');

    const body = init?.body;
    expect(typeof body).toBe('string');
    const payload = JSON.parse(body as string) as {
      name?: string;
      nodes?: Record<string, unknown>[];
    };
    expect(payload.name).toBe('Updated Tree');
    expect(Object.prototype.hasOwnProperty.call(payload.nodes?.[0] ?? {}, 'label')).toBe(false);
  });

  it('opens the add-node palette on N and closes on Escape', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.getByRole('dialog', { name: 'Add node' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add node' })).toBeNull();
  });

  it('does not open the add-node palette on Ctrl+N', () => {
    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Add node' })).toBeNull();
  });

  it('adds workflow inspector edits to the undo stack', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });
    await vi.advanceTimersByTimeAsync(400);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Demo Tree');
  });

  it('supports immediate undo/redo before the history debounce commits', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Demo Tree');

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Updated Tree');
  });

  it('supports undo/redo from top-bar actions', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Demo Tree');

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Updated Tree');
  });

  it('does not trigger global undo shortcuts while typing in an input', async () => {
    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Updated Tree' } });
    expect(nameInput.value).toBe('Updated Tree');

    fireEvent.keyDown(nameInput, { key: 'z', ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Updated Tree');
  });

  it('adds node inspector edits to the undo stack', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Design');

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Updated Node' } });
    await vi.advanceTimersByTimeAsync(400);

    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Updated Node');
    const editedNode = (
      latestReactFlowProps?.nodes as {
        id: string;
        data: { displayName: string; label?: string };
      }[]
    )?.find((node) => node.id === 'design');
    expect(editedNode?.data.displayName).toBe('Updated Node');
    expect(editedNode?.data.label).toBe('Updated Node');

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await vi.advanceTimersByTimeAsync(0);

    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Design');
  });

  it('hydrates React Flow node labels from display names', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const flowNode = (
      latestReactFlowProps?.nodes as {
        id: string;
        data: { displayName: string; label?: string };
      }[]
    )?.find((node) => node.id === 'design');
    expect(flowNode?.data.displayName).toBe('Design');
    expect(flowNode?.data.label).toBe('Design');
  });

  it('renders a transition legend with success, failure, auto, and guard semantics', () => {
    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const legend = screen.getByLabelText('Transition legend');
    expect(within(legend).getByText('success')).toBeInTheDocument();
    expect(within(legend).getByText('failure')).toBeInTheDocument();
    expect(within(legend).getAllByText('auto').length).toBeGreaterThan(0);
    expect(within(legend).getAllByText('guard').length).toBeGreaterThan(0);
    expect(within(legend).getAllByText('in/out').length).toBeGreaterThan(0);
  });

  it('maps success and failure routes to distinct edge styles and minimap semantics', () => {
    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [
            createAgentNode({ nodeKey: 'design', displayName: 'Design' }),
            createAgentNode({ nodeKey: 'implement', displayName: 'Implement', sequenceIndex: 20, position: { x: 300, y: 0 } }),
            createAgentNode({ nodeKey: 'review', displayName: 'Review', sequenceIndex: 30, position: { x: 600, y: 0 } }),
          ],
          edges: [
            createTransitionEdge({
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              routeOn: 'success',
              auto: true,
              priority: 100,
            }),
            createTransitionEdge({
              sourceNodeKey: 'implement',
              targetNodeKey: 'review',
              routeOn: 'failure',
              auto: true,
              priority: 90,
            }),
          ],
          initialRunnableNodeKeys: ['design'],
        })}
      />,
    );

    const flowEdges = latestReactFlowProps?.edges as {
      id: string;
      className?: string;
      label?: string;
      style?: { strokeWidth?: number; strokeDasharray?: string };
      data?: { routeOn?: string };
    }[];

    const successEdge = flowEdges.find(edge => edge.id === 'design->implement:100');
    expect(successEdge?.className).toContain('workflow-edge--success-auto');
    expect(successEdge?.label).toBe('auto · 100');
    expect(successEdge?.style?.strokeWidth).toBe(2.5);
    expect(successEdge?.data?.routeOn).toBe('success');

    const failureEdge = flowEdges.find(edge => edge.id === 'implement->review:failure:90');
    expect(failureEdge?.className).toContain('workflow-edge--failure');
    expect(failureEdge?.label).toBe('failure · 90');
    expect(failureEdge?.style?.strokeWidth).toBe(2.5);
    expect(failureEdge?.style?.strokeDasharray).toBe('9 5');
    expect(failureEdge?.data?.routeOn).toBe('failure');

    const nodeColor = latestMiniMapProps?.nodeColor as ((node: { id: string }) => string) | undefined;
    const nodeStrokeColor = latestMiniMapProps?.nodeStrokeColor as ((node: { id: string }) => string) | undefined;
    expect(typeof nodeColor).toBe('function');
    expect(typeof nodeStrokeColor).toBe('function');
    expect(nodeColor?.({ id: 'design' })).toBe('#dcfce7');
    expect(nodeColor?.({ id: 'review' })).toBe('#fee2e2');
    expect(nodeStrokeColor?.({ id: 'design' })).toBe('#198038');
    expect(nodeStrokeColor?.({ id: 'review' })).toBe('#da1e28');
  });

  it('derives topology classes for fan-out sources, join points, and isolated nodes', () => {
    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [
            createAgentNode({ nodeKey: 'decompose', displayName: 'Decompose', sequenceIndex: 10 }),
            createAgentNode({ nodeKey: 'subtask-a', displayName: 'Subtask A', sequenceIndex: 20 }),
            createAgentNode({ nodeKey: 'subtask-b', displayName: 'Subtask B', sequenceIndex: 30 }),
            createAgentNode({ nodeKey: 'join', displayName: 'Join', sequenceIndex: 40 }),
            createAgentNode({ nodeKey: 'orphan', displayName: 'Orphan', sequenceIndex: 50 }),
          ],
          edges: [
            createTransitionEdge({
              sourceNodeKey: 'decompose',
              targetNodeKey: 'subtask-a',
              routeOn: 'success',
              auto: true,
              priority: 10,
            }),
            createTransitionEdge({
              sourceNodeKey: 'decompose',
              targetNodeKey: 'subtask-b',
              routeOn: 'success',
              auto: true,
              priority: 20,
            }),
            createTransitionEdge({
              sourceNodeKey: 'subtask-a',
              targetNodeKey: 'join',
              routeOn: 'success',
              auto: true,
              priority: 30,
            }),
            createTransitionEdge({
              sourceNodeKey: 'subtask-b',
              targetNodeKey: 'join',
              routeOn: 'success',
              auto: true,
              priority: 40,
            }),
          ],
          initialRunnableNodeKeys: ['decompose', 'orphan'],
        })}
      />,
    );

    const flowNodes = latestReactFlowProps?.nodes as {
      id: string;
      className?: string;
      style?: Record<string, string>;
    }[];
    const flowEdges = latestReactFlowProps?.edges as { id: string; className?: string }[];
    const decomposeNode = flowNodes.find(node => node.id === 'decompose');
    const joinNode = flowNodes.find(node => node.id === 'join');
    const orphanNode = flowNodes.find(node => node.id === 'orphan');
    const fanoutEdge = flowEdges.find(edge => edge.id === 'decompose->subtask-a:10');
    const intoJoinEdge = flowEdges.find(edge => edge.id === 'subtask-a->join:30');

    expect(decomposeNode?.className).toContain('workflow-flow-node--fanout-source');
    expect(joinNode?.className).toContain('workflow-flow-node--join-point');
    expect(orphanNode?.className).toContain('workflow-flow-node--isolated');
    expect(decomposeNode?.style?.['--workflow-node-connection-summary']).toBe('"in 0 / out 2"');
    expect(joinNode?.style?.['--workflow-node-connection-summary']).toBe('"in 2 / out 0"');
    expect(fanoutEdge?.className).toContain('workflow-edge--from-fanout');
    expect(intoJoinEdge?.className).toContain('workflow-edge--into-join');
  });

  it('shows live warnings before manual validation runs', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'review',
              displayName: 'Review',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 100, y: 20 },
              promptTemplate: { content: 'Review prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design', 'review'],
        }}
      />,
    );

    expect(screen.getByText(/Multiple initial runnable nodes detected/i)).toBeInTheDocument();
    expect(screen.getAllByText(/has no outgoing transitions/i)).toHaveLength(2);
  });

  it('runs validation and renders errors and warnings', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/validate')) {
        return createJsonResponse(
          {
            result: {
              errors: [{ code: 'missing_agent', message: 'At least one agent node is required.' }],
              warnings: [{ code: 'draft_placeholders', message: 'Draft placeholders detected.' }],
              initialRunnableNodeKeys: ['design'],
            },
          },
          { status: 200 },
        );
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    });

    expect(await screen.findByText('Errors')).toBeInTheDocument();
    expect(screen.getByText('At least one agent node is required.')).toBeInTheDocument();
    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('Draft placeholders detected.')).toBeInTheDocument();
  });

  it('flushes draft autosave before validation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/validate')) {
        return createJsonResponse(
          {
            result: {
              errors: [],
              warnings: [],
              initialRunnableNodeKeys: [],
            },
          },
          { status: 200 },
        );
      }
      return createJsonResponse({ draft: { draftRevision: 1 } }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];

    expect(String(calls[0]?.[0])).toContain('/draft?version=1');
    expect(calls[0]?.[1]?.method).toBe('PUT');
    const firstPayload = JSON.parse(calls[0]?.[1]?.body as string) as { name: string };
    expect(firstPayload.name).toBe('Updated Tree');

    expect(String(calls[1]?.[0])).toContain('/draft/validate?version=1');
    expect(calls[1]?.[1]?.method).toBe('POST');
  });

  it('publishes the workflow and routes to the tree page', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return createJsonResponse({ workflow: { treeKey: 'demo-tree', version: 1 } }, { status: 200 });
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree');
  });

  it('shows a publish confirmation summary before sending publish requests', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 4,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: 'Release candidate notes',
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'review',
              displayName: 'Review',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Review prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'review',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm publish' });
    expect(within(dialog).getByText('Version bump')).toBeInTheDocument();
    expect(within(dialog).getByText('v3 → v4')).toBeInTheDocument();
    const nodeRow = within(dialog).getByText('Nodes').closest('li');
    expect(nodeRow?.textContent).toContain('2');
    const edgeRow = within(dialog).getByText('Transitions').closest('li');
    expect(edgeRow?.textContent).toContain('1');
    expect(within(dialog).getByText('Release candidate notes')).toBeInTheDocument();

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm publish' })).toBeNull();
  });

  it('flushes draft autosave before publishing', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return createJsonResponse({ workflow: { treeKey: 'demo-tree', version: 1 } }, { status: 200 });
      }
      return createJsonResponse({ draft: { draftRevision: 1 } }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];

    expect(String(calls[0]?.[0])).toContain('/draft?version=1');
    expect(calls[0]?.[1]?.method).toBe('PUT');
    const firstPayload = JSON.parse(calls[0]?.[1]?.body as string) as { name: string };
    expect(firstPayload.name).toBe('Updated Tree');

    expect(String(calls[1]?.[0])).toContain('/draft/publish?version=1');
    expect(calls[1]?.[1]?.method).toBe('POST');
    expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree');
  });

  it('does not publish when the save flush fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return createJsonResponse({ workflow: { treeKey: 'demo-tree', version: 1 } }, { status: 200 });
      }
      return createJsonResponse({ error: { message: 'conflict' } }, { status: 409 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree' } });

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/draft?version=1');
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getAllByText('Save the latest draft changes before publishing.').length).toBeGreaterThan(0);
  });

  it('connects nodes and autosaves a new transition', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const onConnect = latestReactFlowProps?.onConnect;
    expect(typeof onConnect).toBe('function');

    await act(async () => {
      (onConnect as (connection: { source?: string; target?: string }) => void)({
        source: 'design',
        target: 'implement',
      });
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const init = call[1];
    expect(init?.method).toBe('PUT');

    const payload = JSON.parse(init?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'implement',
        routeOn: 'success',
        priority: 100,
        auto: true,
        guardExpression: null,
      },
    ]);
  });

  it('opens add-node palette when a connection is dropped on empty canvas and links the new node', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const onConnect = latestReactFlowProps?.onConnect;
    expect(typeof onConnect).toBe('function');
    await act(async () => {
      (onConnect as (connection: { source?: string; target?: string }) => void)({
        source: 'design',
      });
    });

    const addNodeDialog = screen.getByRole('dialog', { name: 'Add node' });
    expect(addNodeDialog).toBeInTheDocument();
    fireEvent.click(within(addNodeDialog).getByRole('button', { name: /Agent node/i }));
    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'agent',
        routeOn: 'success',
        priority: 100,
        auto: true,
        guardExpression: null,
      },
    ]);
  });

  it('duplicates nodes from the context menu', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const onNodeContextMenu = latestReactFlowProps?.onNodeContextMenu;
    expect(typeof onNodeContextMenu).toBe('function');
    await act(async () => {
      (onNodeContextMenu as (event: unknown, node: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 24,
          clientY: 36,
        },
        { id: 'design' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { nodes?: { nodeKey: string }[] };
    expect(payload.nodes?.map((node) => node.nodeKey)).toContain('design-copy');
  });

  it('recomputes transition edge ids when priority changes and keeps the transition selected', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->implement:100' }],
      });
    });

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '90' } });

    const flowEdges = latestReactFlowProps?.edges as { id: string }[];
    const ids = flowEdges.map((edge) => edge.id);
    expect(ids).toContain('design->implement:90');
    expect(ids).not.toContain('design->implement:100');
    expect((screen.getByLabelText('Priority') as HTMLInputElement).value).toBe('90');
    expect(screen.queryByText('Select a transition to edit details.')).toBeNull();
  });

  it('preserves React Flow runtime edge state when transition details change', async () => {
    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->implement:100' }],
      });
    });

    const selectedFlowEdge = (latestReactFlowProps?.edges as { id: string; selected?: boolean }[]).find(
      edge => edge.id === 'design->implement:100',
    );
    expect(selectedFlowEdge).toBeDefined();
    if (!selectedFlowEdge) {
      throw new Error('Expected selected flow edge to exist.');
    }
    selectedFlowEdge.selected = true;

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '90' } });

    const updatedEdge = (latestReactFlowProps?.edges as { id: string; selected?: boolean }[]).find(
      edge => edge.id === 'design->implement:90',
    );
    expect(updatedEdge?.selected).toBe(true);
  });

  it('keeps transition ids unique after reprioritize then duplicate', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->implement:100' }],
      });
    });

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '90' } });

    const onEdgeContextMenu = latestReactFlowProps?.onEdgeContextMenu;
    expect(typeof onEdgeContextMenu).toBe('function');
    await act(async () => {
      (onEdgeContextMenu as (event: unknown, edge: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 28,
          clientY: 40,
        },
        { id: 'design->implement:90', source: 'design', target: 'implement' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

    const flowEdges = latestReactFlowProps?.edges as { id: string }[];
    const ids = flowEdges.map((edge) => edge.id);
    expect(ids).toContain('design->implement:90');
    expect(ids).toContain('design->implement:100');
    expect(new Set(ids).size).toBe(ids.length);

    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'implement',
        routeOn: 'success',
        priority: 90,
        auto: true,
        guardExpression: null,
      },
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'implement',
        routeOn: 'success',
        priority: 100,
        auto: true,
        guardExpression: null,
      },
    ]);
  });

  it('deletes a selected transition and autosaves', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->implement:100' }],
      });
    });

    fireEvent.keyDown(window, { key: 'Delete' });
    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([]);
  });

  it('supports guard transitions and persists guard expression changes', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->implement:100' }],
      });
    });

    expect(screen.getByText('Auto transitions are unconditional.')).toBeInTheDocument();
    const initialEdge = (latestReactFlowProps?.edges as {
      id: string;
      className?: string;
      style?: { strokeDasharray?: string };
    }[])?.find((edge) => edge.id === 'design->implement:100');
    expect(initialEdge?.className).toContain('workflow-edge--success-auto');
    expect(initialEdge?.style?.strokeDasharray).toBeUndefined();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto' }));
    fireEvent.change(screen.getByLabelText('Guard value 1'), { target: { value: 'blocked' } });

    const updatedEdge = (latestReactFlowProps?.edges as {
      id: string;
      className?: string;
      style?: { strokeDasharray?: string };
    }[])?.find((edge) => edge.id === 'design->implement:100');
    expect(updatedEdge?.className).toContain('workflow-edge--success-guard');
    expect(updatedEdge?.style?.strokeDasharray).toBe('4 4');

    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'implement',
        routeOn: 'success',
        priority: 100,
        auto: false,
        guardExpression: { field: 'decision', operator: '==', value: 'blocked' },
      },
    ]);
  });

  it('supports advanced guard JSON mode and persists parsed expressions', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'review',
              displayName: 'Review',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Review prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'review',
              priority: 100,
              auto: false,
              guardExpression: { field: 'decision', operator: '==', value: 'approved' },
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [],
        edges: [{ id: 'design->review:100' }],
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Raw guard expression'), {
      target: {
        value: '{"logic":"or","conditions":[{"field":"decision","operator":"==","value":"blocked"},{"field":"decision","operator":"==","value":"retry"}]}',
      },
    });
    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'review',
        routeOn: 'success',
        priority: 100,
        auto: false,
        guardExpression: {
          logic: 'or',
          conditions: [
            { field: 'decision', operator: '==', value: 'blocked' },
            { field: 'decision', operator: '==', value: 'retry' },
          ],
        },
      },
    ]);
  });

  it('adds nodes via drop using the flow instance projection', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');

    let preventDefaultCalled = false;
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => {
          preventDefaultCalled = true;
        },
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          getData: () => 'agent',
        },
      });
    });
    expect(preventDefaultCalled).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { nodes?: unknown[] };
    expect(payload.nodes).toEqual([
      {
        nodeKey: 'agent',
        displayName: 'Agent',
        nodeType: 'agent',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        maxRetries: 0,
        sequenceIndex: 10,
        position: { x: 10, y: 20 },
        promptTemplate: { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' },
      },
    ]);
  });

  it('ignores drops when no node type is provided', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');

    let preventDefaultCalled = false;
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => {
          preventDefaultCalled = true;
        },
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          getData: () => '',
        },
      });
    });
    expect(preventDefaultCalled).toBe(true);

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the ReactFlow project() method when screenToFlowPosition is unavailable', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    const onInit = latestReactFlowProps?.onInit;
    expect(typeof onInit).toBe('function');
    await act(async () => {
      (onInit as (instance: unknown) => void)({
        project: (point: { x: number; y: number }) => point,
      });
    });

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');

    let preventDefaultCalled = false;
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => {
          preventDefaultCalled = true;
        },
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          getData: () => 'agent',
        },
      });
    });
    expect(preventDefaultCalled).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips drops when the flow instance cannot project screen coordinates', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    const onInit = latestReactFlowProps?.onInit;
    expect(typeof onInit).toBe('function');
    await act(async () => {
      (onInit as (instance: unknown) => void)({});
    });

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');

    let preventDefaultCalled = false;
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => {
          preventDefaultCalled = true;
        },
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          getData: () => 'agent',
        },
      });
    });
    expect(preventDefaultCalled).toBe(true);

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('generates unique node keys when dropping duplicate node types', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'agent',
              displayName: 'Agent',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['agent'],
        }}
      />,
    );

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');

    let preventDefaultCalled = false;
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => {
          preventDefaultCalled = true;
        },
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          getData: () => 'agent',
        },
      });
    });
    expect(preventDefaultCalled).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { nodes?: { nodeKey: string }[] };
    expect(payload.nodes?.map(node => node.nodeKey)).toContain('agent-2');
  });

  it('updates the draftRevision when the server responds with a higher revision', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: { draftRevision: 50 } }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree 1' } });
    await vi.advanceTimersByTimeAsync(1000);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree 2' } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
    const firstInit = calls[0]?.[1];
    const secondInit = calls[1]?.[1];

    const firstPayload = JSON.parse(firstInit?.body as string) as { draftRevision: number };
    const secondPayload = JSON.parse(secondInit?.body as string) as { draftRevision: number };

    expect(firstPayload.draftRevision).toBe(1);
    expect(secondPayload.draftRevision).toBe(51);
  });

  it('serializes autosave requests while a save is in flight', async () => {
    let saveRequestCount = 0;
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveReleased = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const fetchMock = vi.fn(async () => {
      saveRequestCount += 1;
      if (saveRequestCount === 1) {
        await firstSaveReleased;
        return createJsonResponse({ draft: { draftRevision: 1 } }, { status: 200 });
      }

      return createJsonResponse({ draft: { draftRevision: 2 } }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [],
          edges: [],
          initialRunnableNodeKeys: [],
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree 1' } });
    await vi.advanceTimersByTimeAsync(1000);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Tree 2' } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const completeFirstSave = releaseFirstSave;
    expect(completeFirstSave).toBeTypeOf('function');
    if (!completeFirstSave) {
      throw new Error('Expected first autosave resolver to be initialized.');
    }
    completeFirstSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
    const firstPayload = JSON.parse(calls[0]?.[1]?.body as string) as { draftRevision: number };
    const secondPayload = JSON.parse(calls[1]?.[1]?.body as string) as { draftRevision: number };
    expect(firstPayload.draftRevision).toBe(1);
    expect(secondPayload.draftRevision).toBe(2);
  });

  it('does not autosave for selection-only ReactFlow changes', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const onNodesChange = latestReactFlowProps?.onNodesChange;
    const onEdgesChange = latestReactFlowProps?.onEdgesChange;
    expect(typeof onNodesChange).toBe('function');
    expect(typeof onEdgesChange).toBe('function');

    await act(async () => {
      (onNodesChange as (changes: unknown[]) => void)([
        { id: 'design', type: 'select', selected: true },
      ]);
      (onEdgesChange as (changes: unknown[]) => void)([
        { id: 'design->implement:100', type: 'select', selected: true },
      ]);
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not delete a node when the user cancels confirmation', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    fireEvent.keyDown(window, { key: 'Delete' });
    await vi.advanceTimersByTimeAsync(1200);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes a node and connected transitions when confirmed', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
            {
              nodeKey: 'implement',
              displayName: 'Implement',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [
            {
              sourceNodeKey: 'design',
              targetNodeKey: 'implement',
              priority: 100,
              auto: true,
              guardExpression: null,
            },
          ],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    fireEvent.keyDown(window, { key: 'Delete' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { nodes?: { nodeKey: string }[]; edges?: unknown[] };
    expect(payload.nodes?.map(node => node.nodeKey)).toEqual(['implement']);
    expect(payload.edges).toEqual([]);
  });

  it('renders draft placeholder copy when switching node type away from agent', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={{
          treeKey: 'demo-tree',
          version: 1,
          draftRevision: 0,
          name: 'Demo Tree',
          description: null,
          versionNotes: null,
          nodes: [
            {
              nodeKey: 'design',
              displayName: 'Design',
              nodeType: 'agent',
              provider: 'codex',
              maxRetries: 0,
              sequenceIndex: 10,
              position: { x: 0, y: 0 },
              promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            },
          ],
          edges: [],
          initialRunnableNodeKeys: ['design'],
        }}
      />,
    );

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    fireEvent.change(screen.getByLabelText('Node type'), { target: { value: 'human' } });
    expect(screen.getByText(/draft placeholders/i)).toBeInTheDocument();
  });

  it('bootstraps the draft on mount when bootstrap mode is enabled', async () => {
    vi.useRealTimers();
    const bootstrappedDraft = createInitialDraft({
      treeKey: 'demo tree/alpha',
      name: 'Bootstrapped Tree',
    });
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: bootstrappedDraft }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          treeKey: 'demo tree/alpha',
          name: 'Published Tree',
        })}
        bootstrapDraftOnMount
      />,
    );

    expect(screen.getByText('Creating editable draft version...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Bootstrapped Tree' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(call[0])).toContain('/api/dashboard/workflows/demo%20tree%2Falpha/draft');
    expect(call[1]?.method).toBe('GET');
  });

  it('allows retrying draft bootstrap after an API error', async () => {
    vi.useRealTimers();
    const recoveredDraft = createInitialDraft({ name: 'Recovered Tree' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'conflict' } }, { status: 409 }))
      .mockResolvedValueOnce(createJsonResponse({ draft: recoveredDraft }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Recovered Tree' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows a generic bootstrap error when the API payload does not include a draft', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: null }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Preparing draft failed.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a generic bootstrap error when the API payload draft is malformed', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Preparing draft failed.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it.each([
    { name: 'executionPermissions is not an object', executionPermissions: ['workspace-write'] },
    { name: 'executionPermissions contains unsupported keys', executionPermissions: { unexpected: true } },
    { name: 'executionPermissions.approvalPolicy is invalid', executionPermissions: { approvalPolicy: 'sometimes' } },
    { name: 'executionPermissions.sandboxMode is invalid', executionPermissions: { sandboxMode: 'sometimes' } },
    { name: 'executionPermissions.networkAccessEnabled is not boolean', executionPermissions: { networkAccessEnabled: 'true' } },
    { name: 'executionPermissions.additionalDirectories is not an array', executionPermissions: { additionalDirectories: '/tmp/cache' } },
    { name: 'executionPermissions.webSearchMode is invalid', executionPermissions: { webSearchMode: 'sometimes' } },
  ])('shows a generic bootstrap error when $name', async ({ executionPermissions }) => {
    vi.useRealTimers();
    const malformedDraft = createInitialDraft({
      nodes: [
        {
          ...createAgentNode(),
          executionPermissions: executionPermissions as unknown as DashboardWorkflowDraftNode['executionPermissions'],
        },
      ],
    });
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: malformedDraft }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Preparing draft failed.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('accepts bootstrap drafts with valid executionPermissions fields', async () => {
    vi.useRealTimers();
    const bootstrappedDraft = createInitialDraft({
      name: 'Validated Permissions Draft',
      nodes: [
        createAgentNode({
          executionPermissions: {
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
            networkAccessEnabled: true,
            additionalDirectories: ['/tmp/cache'],
            webSearchMode: 'cached',
          },
        }),
      ],
    });
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: bootstrappedDraft }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Validated Permissions Draft' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows bootstrap network errors from thrown exceptions', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft()}
        bootstrapDraftOnMount
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('shows validation API errors when validation request fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/validate')) {
        return createJsonResponse({ error: { message: 'validation exploded' } }, { status: 422 });
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('validation exploded');
  });

  it('shows a save error and skips validation when draft flush fails', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ error: { message: 'conflict' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Save the latest draft changes before validating.')).toBeInTheDocument();
  });

  it('shows validation network errors when validation throws', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/validate')) {
        throw new Error('validation offline');
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('validation offline');
  });

  it('keeps publish dialog open and shows API errors when publish fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return createJsonResponse({ error: { message: 'publish failed hard' } }, { status: 500 });
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    const dialog = screen.getByRole('dialog', { name: 'Confirm publish' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('publish failed hard');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not close the publish dialog while publishing is in progress', async () => {
    let resolvePublish!: (response: Response) => void;
    const publishResponse = new Promise<Response>((resolve) => {
      resolvePublish = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return publishResponse;
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close publish workflow dialog' }));
    expect(screen.getByRole('dialog', { name: 'Confirm publish' })).toBeInTheDocument();

    resolvePublish(createJsonResponse({ workflow: { treeKey: 'demo-tree', version: 1 } }, { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree');
  });

  it('omits version notes from the publish payload when notes are only whitespace', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/draft/publish')) {
        return createJsonResponse({ workflow: { treeKey: 'demo-tree', version: 1 } }, { status: 200 });
      }
      return createJsonResponse({ draft: {} }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [],
          versionNotes: '   ',
          initialRunnableNodeKeys: [],
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
    const publishPayload = JSON.parse(calls[1]?.[1]?.body as string) as { versionNotes?: string };
    expect(publishPayload).toEqual({});
  });

  it('renames nodes from the context menu and autosaves the change', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Design');

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const onNodeContextMenu = latestReactFlowProps?.onNodeContextMenu;
    expect(typeof onNodeContextMenu).toBe('function');
    await act(async () => {
      (onNodeContextMenu as (event: unknown, node: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 20,
          clientY: 20,
        },
        { id: 'design' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(promptSpy).toHaveBeenCalledWith('Rename node', 'Design');

    await vi.advanceTimersByTimeAsync(1000);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { nodes?: DashboardWorkflowDraftNode[] };
    const renamed = payload.nodes?.find(node => node.nodeKey === 'design');
    expect(renamed?.displayName).toBe('Renamed Design');
  });

  it('closes node context menu when rename target no longer exists', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Should not be used');

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const onNodeContextMenu = latestReactFlowProps?.onNodeContextMenu;
    expect(typeof onNodeContextMenu).toBe('function');
    await act(async () => {
      (onNodeContextMenu as (event: unknown, node: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 16,
          clientY: 16,
        },
        { id: 'missing-node' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes edge context menu when duplicate target edge no longer exists', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [
            createAgentNode(),
            createAgentNode({
              nodeKey: 'implement',
              displayName: 'Implement',
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
            }),
          ],
          edges: [createTransitionEdge()],
          initialRunnableNodeKeys: ['design'],
        })}
      />,
    );

    const onEdgeContextMenu = latestReactFlowProps?.onEdgeContextMenu;
    expect(typeof onEdgeContextMenu).toBe('function');
    await act(async () => {
      (onEdgeContextMenu as (event: unknown, edge: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 20,
          clientY: 20,
        },
        { id: 'missing-edge', source: 'design', target: 'implement' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds connected nodes from the node context menu path', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const onNodeContextMenu = latestReactFlowProps?.onNodeContextMenu;
    expect(typeof onNodeContextMenu).toBe('function');
    await act(async () => {
      (onNodeContextMenu as (event: unknown, node: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 30,
          clientY: 40,
        },
        { id: 'design' },
      );
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add connected node' }));
    const addNodeDialog = screen.getByRole('dialog', { name: 'Add node' });
    fireEvent.click(within(addNodeDialog).getByRole('button', { name: /Agent node/i }));

    await vi.advanceTimersByTimeAsync(1000);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: DashboardWorkflowDraftEdge[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'agent',
        routeOn: 'success',
        priority: 100,
        auto: true,
        guardExpression: null,
      },
    ]);
  });

  it('marks workflow dirty for non-selection node and edge changes', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [
            createAgentNode(),
            createAgentNode({
              nodeKey: 'implement',
              displayName: 'Implement',
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
            }),
          ],
          edges: [createTransitionEdge()],
          initialRunnableNodeKeys: ['design'],
        })}
      />,
    );

    const onNodesChange = latestReactFlowProps?.onNodesChange;
    const onEdgesChange = latestReactFlowProps?.onEdgesChange;
    expect(typeof onNodesChange).toBe('function');
    expect(typeof onEdgesChange).toBe('function');

    await act(async () => {
      (onNodesChange as (changes: unknown[]) => void)([
        { id: 'design', type: 'position', position: { x: 30, y: 40 } },
      ]);
      (onEdgesChange as (changes: unknown[]) => void)([
        { id: 'design->implement:100', type: 'remove' },
      ]);
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores connect events that do not provide a source node', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkflowEditorPageContent
        initialDraft={createInitialDraft({
          nodes: [
            createAgentNode(),
            createAgentNode({
              nodeKey: 'implement',
              displayName: 'Implement',
              sequenceIndex: 20,
              position: { x: 200, y: 0 },
            }),
          ],
          initialRunnableNodeKeys: ['design'],
        })}
      />,
    );

    const onConnect = latestReactFlowProps?.onConnect;
    expect(typeof onConnect).toBe('function');
    await act(async () => {
      (onConnect as (connection: { source?: string; target?: string }) => void)({
        target: 'implement',
      });
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets drag-over dropEffect to move', async () => {
    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const onDragOver = latestReactFlowProps?.onDragOver;
    expect(typeof onDragOver).toBe('function');

    let preventDefaultCalled = false;
    const event = {
      preventDefault: () => {
        preventDefaultCalled = true;
      },
      dataTransfer: {
        dropEffect: 'none',
      },
    };

    await act(async () => {
      (onDragOver as (payload: typeof event) => void)(event);
    });

    expect(preventDefaultCalled).toBe(true);
    expect(event.dataTransfer.dropEffect).toBe('move');
  });

  it('ignores drops when the flow instance has not been initialized', async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ draft: {} }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft({ nodes: [], initialRunnableNodeKeys: [] })} />);

    const onInit = latestReactFlowProps?.onInit;
    expect(typeof onInit).toBe('function');
    await act(async () => {
      (onInit as (instance: unknown) => void)(null);
    });

    const onDrop = latestReactFlowProps?.onDrop;
    expect(typeof onDrop).toBe('function');
    await act(async () => {
      (onDrop as (event: unknown) => void)({
        preventDefault: () => undefined,
        clientX: 12,
        clientY: 18,
        dataTransfer: {
          getData: () => 'agent',
        },
      });
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the inspector drawer on compact view selection and closes it when viewport expands', async () => {
    const listeners = new Set<() => void>();
    const mediaQueryList = {
      matches: true,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        listeners.delete(listener);
      }),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQueryList as unknown as MediaQueryList));

    const { unmount } = render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const selectionChange = latestReactFlowProps?.onSelectionChange;
    expect(typeof selectionChange).toBe('function');
    await act(async () => {
      (selectionChange as (params: { nodes: unknown[]; edges: unknown[] }) => void)({
        nodes: [{ id: 'design' }],
        edges: [],
      });
    });

    expect(screen.getByRole('button', { name: 'Close inspector drawer' })).toBeInTheDocument();
    mediaQueryList.matches = false;
    await act(async () => {
      listeners.forEach(listener => listener());
    });
    expect(screen.queryByRole('button', { name: 'Close inspector drawer' })).toBeNull();

    unmount();
    expect(mediaQueryList.addEventListener).toHaveBeenCalledTimes(1);
    expect(mediaQueryList.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('falls back to matchMedia addListener/removeListener when addEventListener is unavailable', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addListener,
      removeListener,
    }) as unknown as MediaQueryList));

    const { unmount } = render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);
    expect(addListener).toHaveBeenCalledTimes(1);
    unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('offers retry save action after autosave errors and succeeds on retry', async () => {
    let saveAttempts = 0;
    const fetchMock = vi.fn(async () => {
      saveAttempts += 1;
      if (saveAttempts === 1) {
        return createJsonResponse({ error: { message: 'conflict' } }, { status: 409 });
      }
      return createJsonResponse({ draft: { draftRevision: 2 } }, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retry me' } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(screen.getByRole('button', { name: 'Retry save' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
  });

  it('closes the context menu when the pane is clicked', async () => {
    render(<WorkflowEditorPageContent initialDraft={createInitialDraft()} />);

    const onNodeContextMenu = latestReactFlowProps?.onNodeContextMenu;
    expect(typeof onNodeContextMenu).toBe('function');
    await act(async () => {
      (onNodeContextMenu as (event: unknown, node: unknown) => void)(
        {
          preventDefault: () => undefined,
          clientX: 24,
          clientY: 24,
        },
        { id: 'design' },
      );
    });
    expect(screen.getByRole('menu', { name: 'node context menu' })).toBeInTheDocument();

    const onPaneClick = latestReactFlowProps?.onPaneClick;
    expect(typeof onPaneClick).toBe('function');
    await act(async () => {
      (onPaneClick as () => void)();
    });
    expect(screen.queryByRole('menu', { name: 'node context menu' })).toBeNull();
  });
});
