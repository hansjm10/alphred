// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardRepositoryState,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';
import { StoriesIndexPageContent } from './stories-index-client';

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
    createdAt: overrides.createdAt ?? new Date('2026-03-05T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-05T00:00:00.000Z').toISOString(),
    linkedWorkflowRun: overrides.linkedWorkflowRun ?? null,
    effectivePolicy: overrides.effectivePolicy ?? null,
  };
}

describe('StoriesIndexPageContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resets work item state and banners when repository props change', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          story: createWorkItem({ id: 3, type: 'story', title: 'Story A', status: 'Approved', revision: 2 }),
          updatedTasks: [],
          startedTasks: [],
          steps: [{ step: 'start_ready_tasks', outcome: 'skipped', message: 'No Ready child tasks were found to start.' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const actor = { actorType: 'human' as const, actorLabel: 'octocat' };
    const repositoryA = createRepository({ id: 1, name: 'demo-repo' });
    const repositoryB = createRepository({ id: 2, name: 'other-repo', remoteRef: 'octocat/other-repo' });

    const { rerender } = render(
      <StoriesIndexPageContent
        repository={repositoryA}
        actor={actor}
        initialWorkItems={[
          createWorkItem({ id: 3, type: 'story', repositoryId: 1, title: 'Story A', status: 'Draft', revision: 1 }),
          createWorkItem({ id: 20, type: 'task', repositoryId: 1, parentId: 3, title: 'Task A', status: 'Draft', revision: 0 }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    expect(await screen.findByText('Story #3 workflow completed with no task starts.')).toBeInTheDocument();

    rerender(
      <StoriesIndexPageContent
        repository={repositoryB}
        actor={actor}
        initialWorkItems={[
          createWorkItem({ id: 8, type: 'story', repositoryId: 2, title: 'Story B', status: 'Approved', revision: 4 }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'other-repo / Stories' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Story B' })).toHaveAttribute('href', '/repositories/2/stories/8');
    expect(screen.queryByRole('link', { name: 'Story A' })).not.toBeInTheDocument();
    expect(screen.getByText('0 tasks')).toBeInTheDocument();
    expect(screen.queryByText('Story #3 workflow completed with no task starts.')).not.toBeInTheDocument();
  });

  it('ignores stale workflow responses after repository props change', async () => {
    const user = userEvent.setup();
    let resolveWorkflowResponse!: (value: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>(resolve => {
        resolveWorkflowResponse = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const actor = { actorType: 'human' as const, actorLabel: 'octocat' };
    const repositoryA = createRepository({ id: 1, name: 'demo-repo' });
    const repositoryB = createRepository({ id: 2, name: 'other-repo', remoteRef: 'octocat/other-repo' });

    const { rerender } = render(
      <StoriesIndexPageContent
        repository={repositoryA}
        actor={actor}
        initialWorkItems={[
          createWorkItem({ id: 3, type: 'story', repositoryId: 1, title: 'Story A', status: 'Draft', revision: 1 }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Run workflow' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(
      <StoriesIndexPageContent
        repository={repositoryB}
        actor={actor}
        initialWorkItems={[
          createWorkItem({ id: 8, type: 'story', repositoryId: 2, title: 'Story B', status: 'Approved', revision: 4 }),
        ]}
      />,
    );

    resolveWorkflowResponse(
      new Response(
        JSON.stringify({
          story: createWorkItem({ id: 3, type: 'story', repositoryId: 1, title: 'Story A', status: 'Approved', revision: 2 }),
          updatedTasks: [
            createWorkItem({ id: 20, type: 'task', repositoryId: 1, parentId: 3, title: 'Task A', status: 'InProgress', revision: 2 }),
          ],
          startedTasks: [
            createWorkItem({ id: 20, type: 'task', repositoryId: 1, parentId: 3, title: 'Task A', status: 'InProgress', revision: 2 }),
          ],
          steps: [{ step: 'start_ready_tasks', outcome: 'applied', message: 'Started 1 task(s).', startedTaskIds: [20] }],
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'other-repo / Stories' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Story B' })).toHaveAttribute('href', '/repositories/2/stories/8');
      expect(screen.queryByRole('link', { name: 'Story A' })).not.toBeInTheDocument();
      expect(screen.queryByText('Story #3 workflow ran and 1 task started.')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('0 tasks')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run workflow' })).toBeEnabled();
    });
  });
});
