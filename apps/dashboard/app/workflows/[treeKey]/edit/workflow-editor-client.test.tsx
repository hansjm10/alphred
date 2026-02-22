// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

let latestReactFlowProps: Record<string, unknown> | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
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

describe('WorkflowEditorPageContent', () => {
  beforeEach(() => {
    pushMock.mockReset();
    latestReactFlowProps = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const payload = JSON.parse(body as string) as { name?: string };
    expect(payload.name).toBe('Updated Tree');
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

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    });

    expect(pushMock).toHaveBeenCalledWith('/workflows/demo-tree');
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

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto' }));
    fireEvent.change(screen.getByLabelText('Guard (decision)'), { target: { value: 'blocked' } });

    await vi.advanceTimersByTimeAsync(1000);

    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const payload = JSON.parse(call[1]?.body as string) as { edges?: unknown[] };
    expect(payload.edges).toEqual([
      {
        sourceNodeKey: 'design',
        targetNodeKey: 'implement',
        priority: 100,
        auto: false,
        guardExpression: { field: 'decision', operator: '==', value: 'blocked' },
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
});
