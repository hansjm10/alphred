// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import RepositoryBoardPage from './page';
import { RepositoryBoardPageContent } from './repository-board-client';

const { NOT_FOUND_ERROR, createDashboardServiceMock, loadGitHubAuthGateMock, notFoundMock } = vi.hoisted(() => {
  const NOT_FOUND_ERROR = new Error('NOT_FOUND');
  return {
    NOT_FOUND_ERROR,
    createDashboardServiceMock: vi.fn(),
    loadGitHubAuthGateMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw NOT_FOUND_ERROR;
    }),
  };
});

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('../../../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

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
    createDashboardServiceMock.mockReset();
    loadGitHubAuthGateMock.mockReset();
    notFoundMock.mockReset();
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
    expect(screen.getByRole('link', { name: 'Stories' })).toHaveAttribute('href', '/repositories/1/stories');
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
            plannedFiles: ['apps/dashboard/app/repositories/[repositoryId]/board/page.tsx'],
            assignees: ['octocat'],
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));

    expect(screen.getByRole('dialog', { name: 'Write tests' })).toBeInTheDocument();
    expect(screen.getByText('Parent chain')).toBeInTheDocument();
    expect(screen.getByText('epic')).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('story')).toBeInTheDocument();
    expect(screen.getByText('Work items v1')).toBeInTheDocument();
    expect(screen.getByText('Board UI')).toBeInTheDocument();
    expect(screen.getByText('Repo board page')).toBeInTheDocument();

    expect(screen.getByText('Planned files')).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/page.tsx')).toBeInTheDocument();
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

  it('applies board_event created updates to UI state (created adds a new card)', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 1,
        repositoryId: 1,
        workItemId: 42,
        eventType: 'created',
        payload: {
          type: 'task',
          status: 'Ready',
          title: 'New task',
          plannedFiles: ['apps/dashboard/app/repositories/[repositoryId]/board/page.tsx'],
          assignees: ['octocat'],
          revision: 1,
        },
        createdAt: new Date('2026-03-02T02:00:00.000Z').toISOString(),
      });
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Ready' })).getByRole('button', { name: /New task/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New task/ }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/page.tsx')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
  });

  it('applies board_event updated updates to UI state (updated merges supported fields)', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            status: 'Ready',
            revision: 1,
            title: 'Old title',
            plannedFiles: null,
            assignees: ['octocat'],
          }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 2,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'updated',
        payload: {
          changes: {
            title: 'New title',
            plannedFiles: ['apps/dashboard/app/repositories/[repositoryId]/board/repository-board-client.tsx'],
            assignees: null,
            priority: 2,
            estimate: null,
          },
          revision: 2,
        },
        createdAt: new Date('2026-03-02T02:05:00.000Z').toISOString(),
      });
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Ready' })).getByRole('button', { name: /New title/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New title/ }));
    expect(screen.getByRole('dialog', { name: 'New title' })).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/repository-board-client.tsx')).toBeInTheDocument();
    expect(within(screen.getByText('Assignees').closest('div') ?? document.body).getByText('None')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 3,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'updated',
        payload: {
          changes: {
            plannedFiles: 'not-an-array',
            assignees: ['octocat'],
          },
          revision: 3,
        },
        createdAt: new Date('2026-03-02T02:06:00.000Z').toISOString(),
      });
    });

    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/repository-board-client.tsx')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
  });

  it('applies board_event reparented updates to UI state (reparented changes parent chain)', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 1, type: 'epic', title: 'Epic parent' }),
          createWorkItem({ id: 2, type: 'story', title: 'Story parent', parentId: 1 }),
          createWorkItem({ id: 10, type: 'task', status: 'Draft', title: 'Write tests', parentId: 2, revision: 0 }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    expect(screen.getByText('Story parent')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 4,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'reparented',
        payload: { toParentId: 1, revision: 1 },
        createdAt: new Date('2026-03-02T02:10:00.000Z').toISOString(),
      });
    });

    expect(screen.queryByText('Story parent')).not.toBeInTheDocument();
    expect(screen.getByText('Epic parent')).toBeInTheDocument();
  });

  it('ignores malformed board_event payloads without mutating UI state', () => {
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

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 10,
        repositoryId: 1,
        workItemId: 99,
        eventType: 'created',
        payload: { type: 'task', status: 'Ready' },
        createdAt: new Date('2026-03-02T03:00:00.000Z').toISOString(),
      });
    });

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 11,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'updated',
        payload: { changes: null, revision: 1 },
        createdAt: new Date('2026-03-02T03:01:00.000Z').toISOString(),
      });
    });

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 12,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'status_changed',
        payload: { toStatus: 123, revision: 1 },
        createdAt: new Date('2026-03-02T03:02:00.000Z').toISOString(),
      });
    });

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 13,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'reparented',
        payload: null,
        createdAt: new Date('2026-03-02T03:03:00.000Z').toISOString(),
      });
    });

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 14,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'noop',
        payload: {},
        createdAt: new Date('2026-03-02T03:04:00.000Z').toISOString(),
      });
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Draft' })).getByRole('button', { name: /Write tests/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New task/ })).not.toBeInTheDocument();
  });

  it('surfaces board channel errors, malformed events, reconnect state, and supports closing the drawer', async () => {
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

    act(() => {
      MockEventSource.instances[0]?.emit('board_state', { connectionState: 'live', latestEventId: 99 });
    });
    expect(screen.getByLabelText('Connection status: Live')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    const dialog = screen.getByRole('dialog', { name: 'Write tests' });

    const closeButtons = screen.getAllByRole('button', { name: 'Close task details' });
    const backdropButton = closeButtons.find(button => !dialog.contains(button));
    expect(backdropButton).toBeDefined();
    await user.click(backdropButton!);
    expect(screen.queryByRole('dialog', { name: 'Write tests' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    expect(screen.getByRole('dialog', { name: 'Write tests' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Write tests' })).not.toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_error', { message: 'Board stream exploded.' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Board stream exploded.');

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', { nope: true });
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Board event payload was malformed.');

    act(() => {
      MockEventSource.instances[0]?.emitError();
    });
    expect(screen.getByLabelText('Connection status: Reconnecting')).toBeInTheDocument();
  });
});

describe('RepositoryBoardPage (server wrapper)', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    loadGitHubAuthGateMock.mockReset();
    notFoundMock.mockReset();
  });

  it('loads repositories, work items, and the latest board event id for the async page export', async () => {
    const repository = createRepository({ id: 1, name: 'demo-repo' });
    const workItems = [createWorkItem({ id: 10, status: 'Draft', title: 'Write tests' })];

    const service = {
      listRepositories: vi.fn().mockResolvedValue([repository]),
      getRepositoryBoardBootstrap: vi.fn().mockResolvedValue({ repositoryId: 1, latestEventId: 5, workItems }),
    };

    createDashboardServiceMock.mockReturnValue(service);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    const root = (await RepositoryBoardPage({
      params: Promise.resolve({ repositoryId: '1' }),
    })) as ReactElement<{
      repository: DashboardRepositoryState;
      actor: { actorType: 'human' | 'agent' | 'system'; actorLabel: string };
      initialLatestEventId: number;
      initialWorkItems: readonly DashboardWorkItemSnapshot[];
    }>;

    expect(service.listRepositories).toHaveBeenCalledTimes(1);
    expect(service.getRepositoryBoardBootstrap).toHaveBeenCalledWith({ repositoryId: 1 });
    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);

    expect(root.type).toBe(RepositoryBoardPageContent);
    expect(root.props.repository).toEqual(repository);
    expect(root.props.actor).toEqual({ actorType: 'human', actorLabel: 'octocat' });
    expect(root.props.initialLatestEventId).toBe(5);
    expect(root.props.initialWorkItems).toEqual(workItems);
  });

  it('calls notFound when repository does not exist', async () => {
    const service = {
      listRepositories: vi.fn().mockResolvedValue([]),
      getRepositoryBoardBootstrap: vi.fn(),
    };

    createDashboardServiceMock.mockReturnValue(service);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(RepositoryBoardPage({ params: Promise.resolve({ repositoryId: '999' }) })).rejects.toBe(NOT_FOUND_ERROR);

    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to dashboard actor label when the auth gate is unauthenticated', async () => {
    const repository = createRepository({ id: 1, name: 'demo-repo' });
    const service = {
      listRepositories: vi.fn().mockResolvedValue([repository]),
      getRepositoryBoardBootstrap: vi.fn().mockResolvedValue({ repositoryId: 1, latestEventId: 0, workItems: [] }),
    };

    createDashboardServiceMock.mockReturnValue(service);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'unauthenticated', user: null });

    const root = (await RepositoryBoardPage({
      params: Promise.resolve({ repositoryId: '1' }),
    })) as ReactElement<{ actor: { actorType: string; actorLabel: string } }>;

    expect(root.props.actor).toEqual({ actorType: 'human', actorLabel: 'dashboard' });
  });
});
