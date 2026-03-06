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

function createWorkspace(overrides: Partial<DashboardStoryWorkspaceSnapshot> = {}): DashboardStoryWorkspaceSnapshot {
  return {
    id: overrides.id ?? 9,
    repositoryId: overrides.repositoryId ?? 1,
    storyId: overrides.storyId ?? 3,
    path: overrides.path ?? '/tmp/alphred/worktrees/alphred-story-3-a1b2c3',
    branch: overrides.branch ?? 'alphred/story/3-a1b2c3',
    baseBranch: overrides.baseBranch ?? 'main',
    baseCommitHash: overrides.baseCommitHash ?? 'abc123',
    status: overrides.status ?? 'active',
    statusReason: overrides.statusReason ?? null,
    lastReconciledAt: overrides.lastReconciledAt ?? new Date('2026-03-06T00:00:00.000Z').toISOString(),
    removedAt: overrides.removedAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-03-05T10:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-06T00:00:00.000Z').toISOString(),
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

  it('renders story title, status, parent chain, child tasks, and workspace details', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace()}
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
    expect(screen.getByText('Child tasks')).toBeInTheDocument();
    const childTasksSection = screen.getByText('Child tasks').closest('div') as HTMLElement;
    expect(within(childTasksSection).getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Story workspace')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('alphred/story/3-a1b2c3')).toBeInTheDocument();
    expect(screen.getByText('/tmp/alphred/worktrees/alphred-story-3-a1b2c3')).toBeInTheDocument();
  });

  it('hides launch and create affordances for archived repositories without a workspace', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo', archivedAt: '2026-03-06T00:00:00.000Z' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Launch run for this story' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create story workspace' })).toBeNull();
    expect(screen.getByText('Repository "demo-repo" is archived. Restore it before launching runs.')).toBeInTheDocument();
    expect(screen.getByText('Repository is archived. Restore it before creating or recreating a story workspace.')).toBeInTheDocument();
  });

  it('keeps reconcile and cleanup affordances available for archived repositories with an existing workspace', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo', archivedAt: '2026-03-06T00:00:00.000Z' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace()}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Launch run for this story' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recreate workspace' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconcile workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cleanup workspace' })).toBeInTheDocument();
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

  it('creates a story workspace from the story detail actions', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workspace: createWorkspace(),
        created: true,
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
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Create story workspace' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/create-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });

    expect(await screen.findByText('Story workspace ready on branch alphred/story/3-a1b2c3.')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('refresh discovers a workspace that was created after the page loaded', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, name: 'demo-repo' }),
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ workspace: createWorkspace() }))
      .mockResolvedValueOnce(
        createJsonResponse({
          workItems: [createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 })],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItem: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 }) }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1', { method: 'GET' });
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/reconcile-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('alphred/story/3-a1b2c3')).toBeInTheDocument();
  });

  it('keeps the workspace empty on refresh when no workspace exists yet', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, name: 'demo-repo' }),
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'Not found' } }, { status: 404 }))
      .mockResolvedValueOnce(
        createJsonResponse({
          workItems: [createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 })],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItem: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 }) }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={null}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1', { method: 'GET' });
    expect(screen.getByText('No workspace created yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refresh hides launch and recreate affordances after the repository is archived elsewhere', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, name: 'demo-repo', archivedAt: '2026-03-06T00:00:00.000Z' }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({
            status: 'removed',
            statusReason: 'cleanup_requested',
            removedAt: '2026-03-06T01:05:00.000Z',
          }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workItems: [createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 })],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItem: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 }) }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({
          status: 'removed',
          statusReason: 'cleanup_requested',
          removedAt: '2026-03-06T01:05:00.000Z',
        })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    expect(screen.getByRole('link', { name: 'Launch run for this story' })).toHaveAttribute(
      'href',
      '/runs?repository=demo-repo&launchWorkItemId=3',
    );
    expect(screen.getByRole('button', { name: 'Recreate workspace' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.queryByRole('link', { name: 'Launch run for this story' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recreate workspace' })).toBeNull();
    expect(screen.getByText('Repository "demo-repo" is archived. Restore it before launching runs.')).toBeInTheDocument();
    expect(screen.getByText('Repository is archived. Restore it before creating or recreating a story workspace.')).toBeInTheDocument();
  });

  it('refresh restores launch and recreate affordances after the repository is restored elsewhere', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({ id: 1, name: 'demo-repo', archivedAt: null }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workspace: createWorkspace({
            status: 'removed',
            statusReason: 'cleanup_requested',
            removedAt: '2026-03-06T01:05:00.000Z',
          }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          workItems: [createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 })],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(
        createJsonResponse({ workItem: createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 2 }) }),
      );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo', archivedAt: '2026-03-06T00:00:00.000Z' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({
          status: 'removed',
          statusReason: 'cleanup_requested',
          removedAt: '2026-03-06T01:05:00.000Z',
        })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Launch run for this story' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recreate workspace' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('link', { name: 'Launch run for this story' })).toHaveAttribute(
      'href',
      '/runs?repository=demo-repo&launchWorkItemId=3',
    );
    expect(screen.getByRole('button', { name: 'Recreate workspace' })).toBeInTheDocument();
    expect(screen.queryByText('Repository "demo-repo" is archived. Restore it before launching runs.')).toBeNull();
  });

  it('reconciles a stale story workspace and surfaces diagnostics', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workspace: createWorkspace({
          status: 'stale',
          statusReason: 'missing_path',
          updatedAt: '2026-03-06T01:00:00.000Z',
        }),
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace()}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Reconcile workspace' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/reconcile-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });

    expect(await screen.findByText('Story workspace is stale: Workspace directory is missing from disk.')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Workspace directory is missing from disk.')).toBeInTheDocument();
  });

  it('cleans up a story workspace and renders it as removed', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workspace: createWorkspace({
          status: 'removed',
          statusReason: 'cleanup_requested',
          removedAt: '2026-03-06T01:05:00.000Z',
          updatedAt: '2026-03-06T01:05:00.000Z',
        }),
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace()}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cleanup workspace' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/cleanup-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });

    expect(await screen.findByText('Story workspace cleaned up.')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.getByText('The workspace was explicitly cleaned up.')).toBeInTheDocument();
  });

  it('recreates a removed story workspace when the story is still active', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workspace: createWorkspace({
          path: '/tmp/alphred/worktrees/alphred-story-3-d4e5f6',
          branch: 'alphred/story/3-d4e5f6',
          baseCommitHash: 'def456',
          status: 'active',
          statusReason: null,
          removedAt: null,
          updatedAt: '2026-03-06T01:10:00.000Z',
        }),
      }),
    );

    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({
          status: 'removed',
          statusReason: 'cleanup_requested',
          removedAt: '2026-03-06T01:05:00.000Z',
        })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Approved', revision: 1 })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Recreate workspace' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/3/actions/recreate-workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
      }),
    });

    expect(await screen.findByText('Story workspace recreated on branch alphred/story/3-d4e5f6.')).toBeInTheDocument();
    expect(screen.getByText('/tmp/alphred/worktrees/alphred-story-3-d4e5f6')).toBeInTheDocument();
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
        initialWorkspace={createWorkspace()}
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
        initialWorkspace={createWorkspace()}
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

  it('blocks create and recreate affordances when the story is done', () => {
    render(
      <StoryDetailPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        storyId={3}
        initialLatestEventId={0}
        initialProposal={null}
        initialWorkspace={createWorkspace({
          status: 'removed',
          statusReason: 'cleanup_requested',
          removedAt: '2026-03-06T01:05:00.000Z',
        })}
        initialWorkItems={[createWorkItem({ id: 3, type: 'story', title: 'Story title', status: 'Done', revision: 4 })]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Create story workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recreate workspace' })).toBeNull();
    expect(screen.getByText('Story is Done. Clean up the existing workspace instead of creating or recreating a new one.')).toBeInTheDocument();
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

  it('refreshes story state when move requests hit a revision conflict', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'Revision conflict' } }, { status: 409 }))
      .mockResolvedValueOnce(createJsonResponse({ repository: createRepository({ id: 1, name: 'demo-repo' }) }))
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'Not found' } }, { status: 404 }))
      .mockResolvedValueOnce(createJsonResponse({ workItems: [createWorkItem({ id: 3, status: 'Draft', revision: 2 })] }))
      .mockResolvedValueOnce(createJsonResponse({ proposal: null }))
      .mockResolvedValueOnce(createJsonResponse({ workItem: createWorkItem({ id: 3, status: 'Draft', revision: 2 }) }));

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
  });
});
