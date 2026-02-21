// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

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
    ReactFlow: ({ children }: { children?: React.ReactNode }) => <div data-testid="reactflow">{children}</div>,
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
          name: 'Demo Tree',
          description: null,
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
});
