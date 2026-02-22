// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
});
