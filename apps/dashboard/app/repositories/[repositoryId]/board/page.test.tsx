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
    archivedAt: overrides.archivedAt ?? null,
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
    effectivePolicy: overrides.effectivePolicy ?? null,
    linkedWorkflowRun: overrides.linkedWorkflowRun ?? null,
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

  it('shows a detail panel including parent hierarchy, files, and assignees', async () => {
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
    expect(screen.getByText('Parent')).toBeInTheDocument();
    expect(screen.getByText('epic')).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('story')).toBeInTheDocument();
    expect(screen.getByText('Work items v1')).toBeInTheDocument();
    expect(screen.getByText('Board UI')).toBeInTheDocument();
    expect(screen.getByText('Repo board page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/repositories/1/stories/3');

    expect(screen.getByText('Files (1)')).toBeInTheDocument();
    expect(screen.getByText('page.tsx')).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/')).toBeInTheDocument();
    expect(screen.getByText('Assignees')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('Linked run')).toBeInTheDocument();
  });

  it('builds GitHub file links from remoteUrl host when remoteRef is host-prefixed', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({
          id: 1,
          name: 'demo-repo',
          remoteRef: 'ghe.internal.example/octocat/demo-repo',
          remoteUrl: 'https://ghe.internal.example/octocat/demo-repo.git',
        })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'Ready',
            title: 'Write tests',
            plannedFiles: ['src/main.ts'],
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));

    expect(screen.getByRole('link', { name: 'Open src/main.ts in GitHub' })).toHaveAttribute(
      'href',
      'https://ghe.internal.example/octocat/demo-repo/blob/main/src/main.ts',
    );
  });

  it('shows linked run metadata in task details when available', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'InProgress',
            title: 'Linked task',
            linkedWorkflowRun: {
              workflowRunId: 42,
              runStatus: 'running',
              linkedAt: '2026-03-03T00:00:00.000Z',
            },
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Linked task/ }));
    expect(screen.getByText('Linked run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run #42' })).toHaveAttribute('href', '/runs/42');
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('highlights planned-vs-actual mismatches and requests replanning', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        repositoryId: 1,
        workItemId: 10,
        workflowRunId: 42,
        eventId: 77,
        requestedAt: '2026-03-03T00:10:00.000Z',
        plannedButUntouched: ['src/b.ts'],
        touchedButUnplanned: ['src/c.ts'],
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'InProgress',
            title: 'Plan mismatch task',
            plannedFiles: ['src/a.ts', 'src/b.ts'],
            linkedWorkflowRun: {
              workflowRunId: 42,
              runStatus: 'running',
              linkedAt: '2026-03-03T00:00:00.000Z',
              touchedFiles: ['src/a.ts', 'src/c.ts'],
            },
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Plan mismatch task/ }));
    expect(screen.getByText('Plan vs actual')).toBeInTheDocument();
    const planVsActualSection = screen.getByText('Plan vs actual').closest('div');
    expect(planVsActualSection).not.toBeNull();
    expect(within(planVsActualSection ?? document.body).getByText('Planned but not touched')).toBeInTheDocument();
    expect(within(planVsActualSection ?? document.body).getByText('Touched but not planned')).toBeInTheDocument();
    expect(within(planVsActualSection ?? document.body).getByText('src/b.ts')).toBeInTheDocument();
    expect(within(planVsActualSection ?? document.body).getByText('src/c.ts')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request replanning for mismatch' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/1/work-items/10/actions/request-replan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorType: 'human',
        actorLabel: 'octocat',
      }),
    });
    expect(await screen.findByText(/Replanning requested for "Plan mismatch task"/)).toBeInTheDocument();
  });

  it('marks touched files unavailable when linked-run updates omit touchedFiles', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'Ready',
            title: 'Linked run partial update',
            plannedFiles: ['src/a.ts'],
            linkedWorkflowRun: {
              workflowRunId: 42,
              runStatus: 'running',
              linkedAt: '2026-03-03T00:00:00.000Z',
              touchedFiles: ['src/a.ts'],
            },
          }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Linked run partial update/ }));
    expect(screen.getByRole('button', { name: 'Request replanning' })).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 9,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'status_changed',
        payload: {
          type: 'task',
          fromStatus: 'Ready',
          toStatus: 'InProgress',
          revision: 1,
          linkedWorkflowRun: {
            workflowRunId: 42,
            runStatus: 'running',
            linkedAt: '2026-03-03T00:05:00.000Z',
          },
        },
        createdAt: new Date('2026-03-03T00:05:00.000Z').toISOString(),
      });
    });

    expect(screen.getByText('No plan-vs-actual diff available yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request replanning' })).not.toBeInTheDocument();

    const touchedFilesSection = screen.getByText('Touched files').closest('div');
    expect(touchedFilesSection).not.toBeNull();
    expect(
      within(touchedFilesSection ?? document.body).getByText(
        'Touched files are unavailable because the linked run worktree is unavailable.',
      ),
    ).toBeInTheDocument();
  });

  it('hides plan-vs-actual comparison and replanning when touched files are unavailable', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'InProgress',
            title: 'Unavailable touched files',
            plannedFiles: ['src/a.ts'],
            linkedWorkflowRun: {
              workflowRunId: 42,
              runStatus: 'running',
              linkedAt: '2026-03-03T00:00:00.000Z',
            },
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Unavailable touched files/ }));

    const touchedFilesSection = screen.getByText('Touched files').closest('div');
    expect(touchedFilesSection).not.toBeNull();
    expect(
      within(touchedFilesSection ?? document.body).getByText(
        'Touched files are unavailable because the linked run worktree is unavailable.',
      ),
    ).toBeInTheDocument();

    const planVsActualSection = screen.getByText('Plan vs actual').closest('div');
    expect(planVsActualSection).not.toBeNull();
    expect(within(planVsActualSection ?? document.body).getByText('No plan-vs-actual diff available yet.')).toBeInTheDocument();
    expect(within(planVsActualSection ?? document.body).queryByRole('button', { name: /Request replanning/ })).not.toBeInTheDocument();
  });

  it('shows effective policy details for tasks and supports inspecting epic policy from parent chain', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 1,
            type: 'epic',
            title: 'Epic policy',
            effectivePolicy: {
              appliesToType: 'epic',
              epicWorkItemId: 1,
              repositoryPolicyId: 5,
              epicPolicyId: 6,
              policy: {
                allowedProviders: ['codex'],
                allowedModels: ['codex-pro'],
                allowedSkillIdentifiers: ['working-on-github-issue'],
                allowedMcpServerIdentifiers: ['github'],
                budgets: {
                  maxConcurrentTasks: 2,
                  maxConcurrentRuns: 1,
                },
                requiredGates: {
                  breakdownApprovalRequired: false,
                },
              },
            },
          }),
          createWorkItem({ id: 2, type: 'story', title: 'Story', parentId: 1 }),
          createWorkItem({
            id: 3,
            type: 'task',
            status: 'Ready',
            title: 'Task with policy',
            parentId: 2,
            effectivePolicy: {
              appliesToType: 'task',
              epicWorkItemId: 1,
              repositoryPolicyId: 5,
              epicPolicyId: 6,
              policy: {
                allowedProviders: ['codex'],
                allowedModels: ['codex-pro'],
                allowedSkillIdentifiers: ['working-on-github-issue'],
                allowedMcpServerIdentifiers: ['github'],
                budgets: {
                  maxConcurrentTasks: 2,
                  maxConcurrentRuns: 1,
                },
                requiredGates: {
                  breakdownApprovalRequired: false,
                },
              },
            },
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Task with policy/ }));
    expect(screen.getByText('Effective policy')).toBeInTheDocument();
    expect(screen.getByText('Allowed providers')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('Breakdown approval required: No')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Epic policy' }));
    expect(screen.getByRole('dialog', { name: 'Epic policy' })).toBeInTheDocument();
    expect(screen.getByText('Repo policy #5 · Epic policy #6')).toBeInTheDocument();
  });

  it('renders effective policy fallback values when ids and budgets are unset', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'Ready',
            title: 'Task with fallback policy',
            effectivePolicy: {
              appliesToType: 'task',
              epicWorkItemId: null,
              repositoryPolicyId: null,
              epicPolicyId: null,
              policy: {
                allowedProviders: ['codex'],
                allowedModels: ['codex-pro'],
                allowedSkillIdentifiers: ['working-on-github-issue'],
                allowedMcpServerIdentifiers: ['github'],
                budgets: {
                  maxConcurrentTasks: null,
                  maxConcurrentRuns: null,
                },
                requiredGates: {
                  breakdownApprovalRequired: true,
                },
              },
            },
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Task with fallback policy/ }));

    expect(screen.getByText('Repo policy #none · Epic policy #none')).toBeInTheDocument();
    expect(screen.getByText('Max concurrent tasks: Unlimited')).toBeInTheDocument();
    expect(screen.getByText('Max concurrent runs: Unlimited')).toBeInTheDocument();
    expect(screen.getByText('Breakdown approval required: Yes')).toBeInTheDocument();
  });

  it('saves staged status changes via the move API and updates the UI', async () => {
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
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Done');
    await user.click(screen.getByRole('button', { name: 'Save' }));

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

  it('saves drafted files and assignees via the patch API', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({
          id: 10,
          status: 'Draft',
          revision: 1,
          title: 'Write tests',
          plannedFiles: ['src/new-file.ts'],
          assignees: ['alice', 'octocat'],
        }),
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests', plannedFiles: null, assignees: ['octocat'] }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    await user.type(screen.getByRole('textbox', { name: 'Add planned file path' }), 'src/new-file.ts');
    await user.click(screen.getByRole('button', { name: 'Add file' }));
    await user.type(screen.getByRole('combobox', { name: 'Add assignee' }), 'alice');
    await user.click(screen.getByRole('button', { name: 'Add assignee' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/work-items/10', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 0,
        actorType: 'human',
        actorLabel: 'octocat',
        plannedFiles: ['src/new-file.ts'],
        assignees: ['alice', 'octocat'],
      }),
    });

    expect(await screen.findByText('Saved updates for "Write tests".')).toBeInTheDocument();
  });

  it('rejects invalid planned file paths that are not repo-relative file paths', async () => {
    const user = userEvent.setup();

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests', plannedFiles: null })]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Write tests/ }));

    const plannedFileInput = screen.getByRole('textbox', { name: 'Add planned file path' });
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();

    await user.type(plannedFileInput, '..');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    expect(screen.getByText('Enter a repo-relative path (for example: app/page.tsx).')).toBeInTheDocument();
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();

    await user.clear(plannedFileInput);
    await user.type(plannedFileInput, 'src/..');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    expect(screen.getByText('Enter a repo-relative path (for example: app/page.tsx).')).toBeInTheDocument();
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();

    await user.clear(plannedFileInput);
    await user.type(plannedFileInput, '.');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    expect(screen.getByText('Enter a repo-relative path (for example: app/page.tsx).')).toBeInTheDocument();
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();

    await user.clear(plannedFileInput);
    await user.type(plannedFileInput, 'src/');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    expect(screen.getByText('Enter a repo-relative path (for example: app/page.tsx).')).toBeInTheDocument();
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();

    await user.clear(plannedFileInput);
    await user.type(plannedFileInput, 'src//new-file.ts');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    expect(screen.getByText('Enter a repo-relative path (for example: app/page.tsx).')).toBeInTheDocument();
    expect(screen.getByText('No files linked yet.')).toBeInTheDocument();
  });

  it('keeps the current task draft when an earlier task save resolves later', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    let resolveMove!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveMove = resolve;
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Task A' }),
          createWorkItem({ id: 11, status: 'Draft', revision: 0, title: 'Task B' }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Task A/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Done');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await user.click(screen.getByRole('button', { name: /Task B/ }));
    await user.type(screen.getByRole('textbox', { name: 'Add planned file path' }), 'src/task-b.ts');
    await user.click(screen.getByRole('button', { name: 'Add file' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await act(async () => {
      resolveMove(
        createJsonResponse({
          workItem: createWorkItem({ id: 10, status: 'Done', revision: 1, title: 'Task A' }),
        }),
      );
    });

    expect(await screen.findByText('Saved updates for "Task A".')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Task B' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('rebases dirty draft fields when board events update the selected task', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({
          id: 10,
          status: 'InProgress',
          revision: 2,
          title: 'Write tests',
          plannedFiles: ['src/new-file.ts'],
          assignees: ['octocat'],
        }),
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({ id: 10, status: 'Draft', revision: 0, title: 'Write tests', plannedFiles: null, assignees: ['octocat'] }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    await user.type(screen.getByRole('textbox', { name: 'Add planned file path' }), 'src/new-file.ts');
    await user.click(screen.getByRole('button', { name: 'Add file' }));

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 5,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'status_changed',
        payload: { type: 'task', fromStatus: 'Draft', toStatus: 'InProgress', expectedRevision: 0, revision: 1 },
        createdAt: new Date('2026-03-02T01:00:00.000Z').toISOString(),
      });
    });

    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('InProgress');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/dashboard/work-items/10');
    expect(init).toMatchObject({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 1,
        actorType: 'human',
        actorLabel: 'octocat',
        plannedFiles: ['src/new-file.ts'],
      }),
    });
    expect(fetchMock.mock.calls.some(([requestUrl]) => requestUrl === '/api/dashboard/work-items/10/actions/move')).toBe(false);

    expect(await screen.findByText('Saved updates for "Write tests".')).toBeInTheDocument();
  });

  it('merges concurrent board updates into dirty planned files and assignees before save', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);

    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        workItem: createWorkItem({
          id: 10,
          status: 'Draft',
          revision: 2,
          title: 'Write tests',
          plannedFiles: ['src/base.ts', 'src/local.ts', 'src/server.ts'],
          assignees: ['alice', 'bob', 'octocat'],
        }),
      }),
    );

    render(
      <RepositoryBoardPageContent
        repository={createRepository({ id: 1, name: 'demo-repo' })}
        actor={{ actorType: 'human', actorLabel: 'octocat' }}
        initialLatestEventId={0}
        initialWorkItems={[
          createWorkItem({
            id: 10,
            status: 'Draft',
            revision: 0,
            title: 'Write tests',
            plannedFiles: ['src/base.ts'],
            assignees: ['octocat'],
          }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    await user.type(screen.getByRole('textbox', { name: 'Add planned file path' }), 'src/local.ts');
    await user.click(screen.getByRole('button', { name: 'Add file' }));
    await user.type(screen.getByRole('combobox', { name: 'Add assignee' }), 'alice');
    await user.click(screen.getByRole('button', { name: 'Add assignee' }));

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 6,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'updated',
        payload: {
          changes: {
            plannedFiles: ['src/base.ts', 'src/server.ts'],
            assignees: ['bob', 'octocat'],
          },
          revision: 1,
        },
        createdAt: new Date('2026-03-02T01:05:00.000Z').toISOString(),
      });
    });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/dashboard/work-items/10');
    expect(init).toMatchObject({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 1,
        expectedRevision: 1,
        actorType: 'human',
        actorLabel: 'octocat',
        plannedFiles: ['src/base.ts', 'src/local.ts', 'src/server.ts'],
        assignees: ['alice', 'bob', 'octocat'],
      }),
    });
    expect(fetchMock.mock.calls.some(([requestUrl]) => requestUrl === '/api/dashboard/work-items/10/actions/move')).toBe(false);

    expect(await screen.findByText('Saved updates for "Write tests".')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Save' }));

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
          effectivePolicy: {
            appliesToType: 'task',
            epicWorkItemId: 101,
            repositoryPolicyId: 11,
            epicPolicyId: 21,
            policy: {
              allowedProviders: ['codex'],
              allowedModels: ['gpt-5-codex'],
              allowedSkillIdentifiers: ['working-on-github-issue'],
              allowedMcpServerIdentifiers: ['github'],
              budgets: {
                maxConcurrentTasks: 2,
                maxConcurrentRuns: 1,
              },
              requiredGates: {
                breakdownApprovalRequired: false,
              },
            },
          },
        },
        createdAt: new Date('2026-03-02T02:00:00.000Z').toISOString(),
      });
    });

    expect(within(screen.getByRole('region', { name: 'Tasks Ready' })).getByRole('button', { name: /New task/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New task/ }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
    expect(screen.getByText('page.tsx')).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.getByText('Repo policy #11 · Epic policy #21')).toBeInTheDocument();
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
    expect(screen.getByText('repository-board-client.tsx')).toBeInTheDocument();
    expect(screen.getByText('apps/dashboard/app/repositories/[repositoryId]/board/')).toBeInTheDocument();
    expect(screen.getByText('No assignees yet.')).toBeInTheDocument();

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

    expect(screen.getByText('repository-board-client.tsx')).toBeInTheDocument();
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
          createWorkItem({
            id: 10,
            type: 'task',
            status: 'Draft',
            title: 'Write tests',
            parentId: 2,
            revision: 0,
            effectivePolicy: {
              appliesToType: 'task',
              epicWorkItemId: 1,
              repositoryPolicyId: 7,
              epicPolicyId: 13,
              policy: {
                allowedProviders: ['codex'],
                allowedModels: ['gpt-5-codex'],
                allowedSkillIdentifiers: ['working-on-github-issue'],
                allowedMcpServerIdentifiers: ['github'],
                budgets: {
                  maxConcurrentTasks: 2,
                  maxConcurrentRuns: 1,
                },
                requiredGates: {
                  breakdownApprovalRequired: false,
                },
              },
            },
          }),
        ]}
      />,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0]?.emitOpen();

    await user.click(screen.getByRole('button', { name: /Write tests/ }));
    expect(screen.getByText('Story parent')).toBeInTheDocument();
    expect(screen.getByText('Repo policy #7 · Epic policy #13')).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0]?.emit('board_event', {
        id: 4,
        repositoryId: 1,
        workItemId: 10,
        eventType: 'reparented',
        payload: {
          toParentId: 1,
          revision: 1,
          effectivePolicy: {
            appliesToType: 'task',
            epicWorkItemId: 1,
            repositoryPolicyId: 7,
            epicPolicyId: 22,
            policy: {
              allowedProviders: ['codex'],
              allowedModels: ['gpt-5-codex'],
              allowedSkillIdentifiers: ['working-on-github-issue'],
              allowedMcpServerIdentifiers: ['github'],
              budgets: {
                maxConcurrentTasks: 4,
                maxConcurrentRuns: 2,
              },
              requiredGates: {
                breakdownApprovalRequired: true,
              },
            },
          },
        },
        createdAt: new Date('2026-03-02T02:10:00.000Z').toISOString(),
      });
    });

    expect(screen.queryByText('Story parent')).not.toBeInTheDocument();
    expect(screen.getByText('Epic parent')).toBeInTheDocument();
    expect(screen.queryByText('Repo policy #7 · Epic policy #13')).not.toBeInTheDocument();
    expect(screen.getByText('Repo policy #7 · Epic policy #22')).toBeInTheDocument();
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

    const closeButtons = screen.getAllByRole('button', { name: 'Close work item details' });
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
    expect(service.listRepositories).toHaveBeenCalledWith({ includeArchived: false });
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
