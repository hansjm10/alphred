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
    ReactFlow: (props: { children?: React.ReactNode }) => {
      latestReactFlowProps = props as unknown as Record<string, unknown>;
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
});
