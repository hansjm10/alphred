// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '../../../../src/server/dashboard-contracts';
import { RepositoryBoardPageContent } from './repository-board-client';

type EventHandler = (event: Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map<string, Set<EventHandler>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventHandler) {
    const existing = this.handlers.get(type) ?? new Set();
    existing.add(handler);
    this.handlers.set(type, existing);
  }

  close() {
    this.handlers.clear();
  }

  emit(type: string, data: unknown) {
    const handlers = this.handlers.get(type);
    if (!handlers) {
      return;
    }
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const handler of handlers) {
      handler(event);
    }
  }

  emitOpen() {
    this.onopen?.();
  }

  emitError() {
    this.onerror?.();
  }
}

function createRepository(overrides: Partial<DashboardRepositoryState> = {}): DashboardRepositoryState {
  return {
    id: overrides.id ?? 1,
    name: overrides.name ?? 'demo-repo',
    provider: overrides.provider ?? 'github',
    remoteRef: overrides.remoteRef ?? 'octocat/demo-repo',
    remoteUrl: overrides.remoteUrl ?? 'https://github.com/octocat/demo-repo.git',
    defaultBranch: overrides.defaultBranch ?? 'main',
    branchTemplate: overrides.branchTemplate ?? null,
    cloneStatus: overrides.cloneStatus ?? 'cloned',
    localPath: overrides.localPath ?? '/tmp/repos/demo-repo',
  };
}

function createWorkItem(overrides: Partial<DashboardWorkItemSnapshot> = {}): DashboardWorkItemSnapshot {
  return {
    id: overrides.id ?? 10,
    repositoryId: overrides.repositoryId ?? 1,
    type: overrides.type ?? 'task',
    status: overrides.status ?? 'Draft',
    title: overrides.title ?? 'Write tests',
    description: overrides.description ?? null,
    parentId: overrides.parentId ?? null,
    tags: overrides.tags ?? null,
    plannedFiles: overrides.plannedFiles ?? null,
    assignees: overrides.assignees ?? null,
    priority: overrides.priority ?? null,
    estimate: overrides.estimate ?? null,
    revision: overrides.revision ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
  };
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

describe('RepositoryBoardPageContent', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances = [];
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders Kanban columns for task statuses and places tasks into the right column', () => {
    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 10, status: 'Draft', title: 'Write tests' }),
          createWorkItem({ id: 11, status: 'InProgress', title: 'Fix flaky test' }),
          createWorkItem({ id: 12, status: 'Done', title: 'Ship it' }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'demo-repo board' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks Draft' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks Ready' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks InProgress' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks Blocked' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks InReview' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks Done' })).toBeInTheDocument();

    expect(within(screen.getByRole('region', { name: 'Tasks Draft' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Tasks InProgress' })).getByRole('button', { name: /Fix flaky test/ })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Tasks Done' })).getByRole('button', { name: /Ship it/ })).toBeInTheDocument();
  });

  it('shows a detail panel including parent chain, planned files, and assignees', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 1, type: 'epic', title: 'Work items v1' }),
          createWorkItem({ id: 2, type: 'feature', title: 'Board UI', parentId: 1 }),
          createWorkItem({ id: 3, type: 'story', title: 'Repo board page', parentId: 2 }),
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'Ready',
            title: 'Write tests',
            parentId: 3,
            plannedFiles: ['apps/dashboard/app/repositories/[name]/board/page.tsx'],
            assignees: ['octocat'],
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));

    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();
    expect(screen.getByText('Parent chain')).toBeInTheDocument();
    expect(screen.getByText('epic')).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('story')).toBeInTheDocument();
    expect(screen.getByText('Work items v1')).toBeInTheDocument();
    expect(screen.getByText('Board UI')).toBeInTheDocument();
    expect(screen.getByText('Repo board page')).toBeInTheDocument();

    expect(screen.getByText('Planned files')).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[name]/board/page.tsx')).toBeInTheDocument();
    expect(screen.getByText('Assignees')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
  });

  it('moves a task via the move API and updates the UI', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({ id: 10, status: 'Done', revision: 1, title: 'Write tests' }),
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests' })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Done');

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/10/actions/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 0,
        toStatus: 'Done',
        actorType: 'human',
        actorLabel: 'octocat',
      }),
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Done' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();
  });

  it('handles 409 conflicts by refreshing the task from the server', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse(
          { error: { code: 'conflict', message: 'Work item id=10 revision conflict (expected 0).' } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workItem: createWorkItem({ id: 10, status: 'InProgress', revision: 2, title: 'Write tests' }),
        }),
      );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests' })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'InProgress');

    expect(await screen.findByRole('alert')).toHaveTextContent('Refreshed from server.');
    expect(within(screen.getByRole('region', { name: 'Tasks InProgress' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/dashboard/work-items/10?repositoryId=1',
      { method: 'GET' },
    );
  });

  it('applies board_event updates to UI state (status_changed moves cards across columns)', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests' })]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 5,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'status_changed',
        payload: { type: 'task', fromStatus: 'Draft', toStatus: 'Done', expectedRevision: 0, revision: 1 },
        createdAt: new Date('2026-03-02T01:00:00.000Z').toISOString(),
      });
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Done' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();
  });
});
