// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardRepositoryState,
  DashboardStoryBreakdownProposalSnapshot,
  DashboardStoryWorkspaceSnapshot,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';
import { StoryDetailPageContent } from './story-detail-client';

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
    archivedAt: overrides.archivedAt ?? null,
  };
}

function createWorkItem(overrides: Partial<DashboardWorkItemSnapshot> = {}): DashboardWorkItemSnapshot {
  return {
    id: overrides.id ?? 10,
    repositoryId: overrides.repositoryId ?? 1,
    type: overrides.type ?? 'story',
    status: overrides.status ?? 'Draft',
    title: overrides.title ?? 'Story title',
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

function createProposal(overrides: Partial<DashboardStoryBreakdownProposalSnapshot> = {}): DashboardStoryBreakdownProposalSnapshot {
  return {
    eventId: overrides.eventId ?? 99,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    createdTaskIds: overrides.createdTaskIds ?? [20, 21],
    proposed: overrides.proposed ?? {
      tags: null,
      plannedFiles: ['src/a.ts'],
      links: null,
      tasks: [
        { title: 'Task A', plannedFiles: ['src/a.ts'] },
        { title: 'Task B', plannedFiles: ['src/b.ts'] },
      ],
    },
  };
}

function createWorkspace(overrides: Partial<DashboardStoryWorkspaceSnapshot> = {}): DashboardStoryWorkspaceSnapshot {
  return {
    id: overrides.id ?? 8,
    repositoryId: overrides.repositoryId ?? 1,
    storyId: overrides.storyId ?? 3,
    path: overrides.path ?? '/tmp/repos/demo-repo/.worktrees/story-3',
    branch: overrides.branch ?? 'alphred/story/3-demo',
    baseBranch: overrides.baseBranch ?? 'main',
    baseCommitHash:
      'baseCommitHash' in overrides ? (overrides.baseCommitHash ?? null) : 'abc123',
    status: overrides.status ?? 'active',
    statusReason: overrides.statusReason ?? null,
    lastReconciledAt:
      'lastReconciledAt' in overrides
        ? (overrides.lastReconciledAt ?? null)
        : new Date('2026-03-03T00:00:00.000Z').toISOString(),
    removedAt: 'removedAt' in overrides ? (overrides.removedAt ?? null) : null,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-03T00:00:00.000Z').toISOString(),
  };
}

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

describe('StoryDetailPageContent', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances = [];
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders story title, workspace metadata, parent chain, and child tasks', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({ storyId: 3, statusReason: 'branch_mismatch' })}
        initialWorkItems={[
          createWorkItem({ id: 1, type: 'epic', title: 'Epic' }),
          createWorkItem({ id: 2, type: 'feature', title: 'Feature', parentId: 1 }),
          createWorkItem({ id: 3, type: 'story', title: 'Story title', parentId: 2, status: 'Draft' }),
          createWorkItem({ id: 20, type: 'task', title: 'Task A', parentId: 3, status: 'Draft' }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'demo-repo / Story #3' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stories' })).toHaveAttribute('href', '/repositories/1/stories');
    expect(screen.getByRole('link', { name: 'Launch run for this story' })).toHaveAttribute(
      'href',
      '/runs?repository=demo-repo&launchWorkItemId=3',
    );
    expect(screen.getByText('Story title')).toBeInTheDocument();
    const storyHeader = screen.getByRole('heading', { name: 'Story' }).closest('header') as HTMLElement;
    expect(within(storyHeader).getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Parent chain')).toBeInTheDocument();
    expect(screen.getByText('Epic')).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Status: Active')).toBeInTheDocument();
    expect(screen.getByText('Status reason: Branch mismatch')).toBeInTheDocument();
    expect(screen.getByText('Clone status: cloned')).toBeInTheDocument();
    expect(screen.getByText('Child tasks')).toBeInTheDocument();
    const childTasksSection = screen.getByText('Child tasks').closest('div') as HTMLElement;
    expect(within(childTasksSection).getByText('Task A')).toBeInTheDocument();
  });

  it('requests breakdown by moving the story to NeedsBreakdown', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        story: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 1 }),
        updatedTasks: [],
        startedTasks: [],
        steps: [
          { step: 'move_to_needs_breakdown', outcome: 'applied', message: 'Moved story to NeedsBreakdown.' },
          {
            step: 'generate_breakdown',
            outcome: 'blocked',
            message: 'Story is waiting for a breakdown proposal.',
          },
          { step: 'approve_breakdown', outcome: 'skipped', message: 'Skipped approval in generate-only mode.' },
          { step: 'start_ready_tasks', outcome: 'skipped', message: 'Skipped task start in generate-only mode.' },
        ],
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Draft', revision: 0 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request breakdown' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/run-story-workflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 0,
        actorType: 'human',
        actorLabel: 'octocat',
        generateOnly: true,
      }),
    });

    expect(screen.getByText('Needs breakdown')).toBeInTheDocument();
  });

  it('shows proposed plan in BreakdownProposed and supports approval', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        story: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 }),
        updatedTasks: [
          createWorkItem({ id: 20, type: 'task', title: 'Task A', parentId: 3, status: 'Ready', revision: 1 }),
          createWorkItem({ id: 21, type: 'task', title: 'Task B', parentId: 3, status: 'Ready', revision: 1 }),
        ],
        startedTasks: [],
        steps: [
          { step: 'approve_breakdown', outcome: 'applied', message: 'Approved breakdown and moved child tasks to Ready.' },
          { step: 'start_ready_tasks', outcome: 'skipped', message: 'Skipped task start for this mode.' },
        ],
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal()}
        initialWorkspace={createWorkspace({ storyId: 3 })}
        initialWorkItems={[
          createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 }),
          createWorkItem({ id: 20, type: 'task', title: 'Task A', parentId: 3, status: 'Draft', revision: 0 }),
          createWorkItem({ id: 21, type: 'task', title: 'Task B', parentId: 3, status: 'Draft', revision: 0 }),
        ]}
      />,
    );

    expect(screen.getByText('Proposed plan')).toBeInTheDocument();
    expect(screen.getByText('Proposed planned files')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('Proposed tasks')).toBeInTheDocument();
    const proposedPlanSection = screen.getByText('Proposed plan').closest('div') as HTMLElement;
    expect(within(proposedPlanSection).getByText('Task A')).toBeInTheDocument();
    expect(within(proposedPlanSection).getByText('Task B')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve breakdown' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/run-story-workflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 1,
        actorType: 'human',
        actorLabel: 'octocat',
        approveOnly: true,
      }),
    });
    expect(screen.getByText('Approved')).toBeInTheDocument();
    const childTasksSection = screen.getByText('Child tasks').closest('div') as HTMLElement;
    expect(within(childTasksSection).getAllByText('Ready')).toHaveLength(2);
  });

  it('renders removed workspaces and proposal fallbacks for missing planned files', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal({
          proposed: {
            tags: null,
            plannedFiles: null,
            links: null,
            tasks: [{ title: 'Task without files', plannedFiles: null }],
          },
        })}
        initialWorkspace={createWorkspace({
          storyId: 3,
          status: 'removed',
          statusReason: 'removed_state_drift',
          baseCommitHash: null,
          lastReconciledAt: null,
          removedAt: new Date('2026-03-04T00:00:00.000Z').toISOString(),
        })}
        initialWorkItems={[
          createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 }),
          createWorkItem({ id: 20, type: 'task', title: 'Task A', parentId: 3, status: 'InProgress', revision: 0 }),
          createWorkItem({ id: 21, type: 'task', title: 'Task B', parentId: 3, status: 'InReview', revision: 0 }),
        ]}
      />,
    );

    expect(screen.getByText('Status: Removed')).toBeInTheDocument();
    expect(screen.getByText('Status reason: Removed state drift')).toBeInTheDocument();
    expect(screen.getByText('Base commit: None')).toBeInTheDocument();
    expect(screen.getByText('Last reconciled: None')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recreate workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconcile workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cleanup workspace' })).not.toBeInTheDocument();

    const proposedPlanSection = screen.getByText('Proposed plan').closest('div') as HTMLElement;
    expect(within(proposedPlanSection).getByText('None')).toBeInTheDocument();
    expect(within(proposedPlanSection).queryByText(/Files:/)).not.toBeInTheDocument();

    const childTasksSection = screen.getByText('Child tasks').closest('div') as HTMLElement;
    expect(within(childTasksSection).getByText('In progress')).toBeInTheDocument();
    expect(within(childTasksSection).getByText('In review')).toBeInTheDocument();
  });

  it('supports request-changes by moving the story back to NeedsBreakdown', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 2 }),
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal()}
        initialWorkspace={createWorkspace({ storyId: 3 })}
        initialWorkItems={[
          createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 }),
          createWorkItem({ id: 20, type: 'task', title: 'Task A', parentId: 3, status: 'Draft', revision: 0 }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 1,
        toStatus: 'NeedsBreakdown',
        actorType: 'human',
        actorLabel: 'octocat',
      }),
    });
    expect(screen.getByText('Needs breakdown')).toBeInTheDocument();
  });

  it('handles board stream breakdown proposal events by showing the proposed plan', async () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 0 })]}
      />,
    );

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 10,
        repositoryId: 1,
        workItemId: 3,
        eventType: 'breakdown_proposed',
        payload: {
          toStatus: 'BreakdownProposed',
          revision: 1,
          proposed: createProposal().proposed,
          createdTaskIds: [20, 21],
        },
        createdAt: new Date('2026-03-02T00:00:00.000Z').toISOString(),
      });
    });

    expect(await screen.findByText('Proposed plan')).toBeInTheDocument();
  });

  it('updates the board stream state, handles malformed board errors, and clears proposals on approval events', async () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal()}
        initialWorkspace={createWorkspace({ storyId: 3 })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 })]}
      />,
    );

    act(() => {
      MockEventSource.instances[0]?.emitOpen();
    });

    expect(screen.getByText('Board stream: live')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_error', { code: 'bad-payload' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Board stream error.');

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 11,
        repositoryId: 1,
        workItemId: 3,
        eventType: 'breakdown_approved',
        payload: {
          toStatus: 'Approved',
          revision: 2,
        },
        createdAt: new Date('2026-03-02T00:05:00.000Z').toISOString(),
      });
    });

    expect(screen.queryByText('Proposed plan')).not.toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('shows a not-found state when the story is missing', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[]}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Story not found.');
  });

  it('surfaces board stream errors and reconnects after drops', async () => {
    vi.useFakeTimers();
    try {
      render(
        <StoryDetailPageContent
          repository={createRepository({ id: 1, name: 'demo-repo' })}
          actor={{ actorType: 'human', actorLabel: 'octocat' }}
          storyId={3}
          initialLatestEventId={0}
          initialProposal={null}
          initialWorkspace={null}
          initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 0 })]}
        />,
      );

      act(() => {
        MockEventSource.instances[0]?.emit('board_error', { message: 'Board said nope.' });
      });

      expect(screen.getByText('Board said nope.')).toBeInTheDocument();

      act(() => {
        MockEventSource.instances[0]?.emitError();
      });

      expect(screen.getByText('Connection lost. Reconnecting…')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(MockEventSource.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows workflow errors when approving a breakdown fails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse(
        {
          error: {
            message: 'Breakdown approval is blocked until repository sync completes.',
          },
        },
        { status: 410 },
      ),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal()}
        initialWorkspace={createWorkspace({ storyId: 3 })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve breakdown' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Breakdown approval is blocked until repository sync completes.',
    );
  });

  it('creates a workspace, refreshes story detail, and shows a success notice', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ workspace: createWorkspace({ storyId: 3 }) }))
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, cloneStatus: 'cloned', localPath: '/tmp/repos/demo-repo' }),
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'Draft', revision: 2 })] }))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'Draft', revision: 2 }) }))
      .mockResolvedValueOnce(createJsonResponse({ workspace: createWorkspace({ storyId: 3, status: 'active' }) }));

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, cloneStatus: 'pending', localPath: null })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Draft', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/work-items/3/actions/create-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/workspace?repositoryId=1', { method: 'GET' });
    expect(await screen.findByText('Workspace created.')).toBeInTheDocument();
    expect(screen.getByText('Clone status: cloned')).toBeInTheDocument();
    expect(screen.getByText('Local path: /tmp/repos/demo-repo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cleanup workspace' })).toBeInTheDocument();
  });

  it('surfaces workspace action failures', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse(
        {
          error: {
            message: 'Repository "demo-repo" is archived. Restore it before creating a story workspace.',
          },
        },
        { status: 409 },
      ),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Draft', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Repository "demo-repo" is archived. Restore it before creating a story workspace.',
    );
  });

  it('shows a partial success message when workspace recreation succeeds but refresh fails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({
            storyId: 3,
            status: 'stale',
            statusReason: 'reconcile_failed',
          }),
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({}))
      .mockResolvedValueOnce(createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'Draft', revision: 2 })] }))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'Draft', revision: 2 }) }))
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({ storyId: 3, status: 'stale', statusReason: 'reconcile_failed' }),
        }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({ storyId: 3, status: 'removed', statusReason: 'missing_path' })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Draft', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Recreate workspace' }));

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/work-items/3/actions/recreate-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });
    expect(await screen.findByText(
      'Workspace recreated. Unable to refresh story detail: Unable to refresh repository (malformed response).',
    )).toBeInTheDocument();
    expect(screen.getByText('Status reason: Reconcile failed')).toBeInTheDocument();
  });

  it('refreshes repository and workspace state when refresh is requested', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, cloneStatus: 'cloned', localPath: '/tmp/repos/demo-repo' }),
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'NeedsBreakdown', revision: 2 })] }))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'NeedsBreakdown', revision: 2 }) }))
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({ storyId: 3, status: 'stale', statusReason: 'repository_clone_missing' }),
        }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, cloneStatus: 'pending', localPath: null })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({ storyId: 3, status: 'active' })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/workspace?repositoryId=1', { method: 'GET' });
    expect(await screen.findByText('Status: Stale')).toBeInTheDocument();
    expect(screen.getByText('Status reason: Repository clone missing')).toBeInTheDocument();
    expect(screen.getByText('Local path: /tmp/repos/demo-repo')).toBeInTheDocument();
  });

  it('shows refresh errors when the latest snapshot response is malformed', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ repository: createRepository({ id: 1 }) }))
      .mockResolvedValueOnce(createJsonResponse({}))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'NeedsBreakdown', revision: 2 }) }))
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({ storyId: 3, status: 'stale', statusReason: 'worktree_not_registered' }),
        }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({ storyId: 3, status: 'active' })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'NeedsBreakdown', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to refresh work items (malformed response).');
  });

  it('refreshes story state when move requests hit a revision conflict', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'Revision conflict' } }, { status: 409 }))
      .mockResolvedValueOnce(createJsonResponse({ repository: createRepository({ id: 1 }) }))
      .mockResolvedValueOnce(createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'Draft', revision: 2 })] }))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'Draft', revision: 2 }) }))
      .mockResolvedValueOnce(createJsonResponse({ workspace: null }));

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Draft', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request breakdown' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict: Revision conflict');
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1/work-items', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/workspace?repositoryId=1', { method: 'GET' });
  });

  it('refreshes story state when request-change moves hit a revision conflict', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'Revision conflict' } }, { status: 409 }))
      .mockResolvedValueOnce(createJsonResponse({ repository: createRepository({ id: 1 }) }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'BreakdownProposed', revision: 2 })] }),
      )
      .mockResolvedValueOnce(createJsonResponse({ proposal: createProposal() }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'BreakdownProposed', revision: 2 }) }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({ storyId: 3, status: 'stale', statusReason: 'cleanup_requested' }),
        }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={createProposal()}
        initialWorkspace={createWorkspace({ storyId: 3, status: 'active' })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'BreakdownProposed', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict: Revision conflict');
    expect(screen.getByText('Status reason: Cleanup requested')).toBeInTheDocument();
  });
});
