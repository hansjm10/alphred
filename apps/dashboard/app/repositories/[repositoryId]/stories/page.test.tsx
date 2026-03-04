// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import StoriesIndexPage from './page';

const { NOT_FOUND_ERROR, createDashboardServiceMock, loadDashboardRepositoriesMock, notFoundMock } = vi.hoisted(() => {
  const NOT_FOUND_ERROR = new Error('NOT_FOUND');
  return {
    NOT_FOUND_ERROR,
    createDashboardServiceMock: vi.fn(),
    loadDashboardRepositoriesMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw NOT_FOUND_ERROR;
    }),
  };
});

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('../../load-dashboard-repositories', () => ({
  loadDashboardRepositories: loadDashboardRepositoriesMock,
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

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

describe('StoriesIndexPage', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    loadDashboardRepositoriesMock.mockReset();
    notFoundMock.mockClear();
  });

  it('renders stories with status and child task counts', async () => {
    const repository = createRepository({ id: 1, name: 'demo-repo' });
    const workItems = [
      createWorkItem({ id: 3, type: 'story', title: 'Story A', status: 'NeedsBreakdown' }),
      createWorkItem({ id: 4, type: 'story', title: 'Story B', status: 'Draft' }),
      createWorkItem({ id: 20, type: 'task', title: 'Task 1', parentId: 3, status: 'Draft' }),
      createWorkItem({ id: 21, type: 'task', title: 'Task 2', parentId: 3, status: 'Draft' }),
    ];

    const service = {
      getRepositoryBoardBootstrap: vi.fn().mockResolvedValue({ repositoryId: 1, latestEventId: 0, workItems }),
    };

    createDashboardServiceMock.mockReturnValue(service);
    loadDashboardRepositoriesMock.mockResolvedValue([repository]);

    const root = await StoriesIndexPage({ params: Promise.resolve({ repositoryId: '1' }) });
    render(root);

    expect(loadDashboardRepositoriesMock).toHaveBeenCalledWith(false);
    expect(screen.getByRole('heading', { name: 'demo-repo / Stories' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/repositories/1/board');

    const storiesHeader = screen.getByRole('heading', { name: 'Stories' }).closest('header') as HTMLElement;
    expect(within(storiesHeader).getByText('2')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Story A' })).toHaveAttribute('href', '/repositories/1/stories/3');
    expect(screen.getByText('Needs breakdown')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
  });

  it('shows an empty state when no stories exist', async () => {
    const repository = createRepository({ id: 1, name: 'demo-repo' });
    const service = {
      getRepositoryBoardBootstrap: vi.fn().mockResolvedValue({ repositoryId: 1, latestEventId: 0, workItems: [] }),
    };

    createDashboardServiceMock.mockReturnValue(service);
    loadDashboardRepositoriesMock.mockResolvedValue([repository]);

    const root = await StoriesIndexPage({ params: Promise.resolve({ repositoryId: '1' }) });
    render(root);

    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('calls notFound when repository id is invalid', async () => {
    createDashboardServiceMock.mockReturnValue({ getRepositoryBoardBootstrap: vi.fn() });
    loadDashboardRepositoriesMock.mockResolvedValue([createRepository({ id: 1 })]);

    await expect(StoriesIndexPage({ params: Promise.resolve({ repositoryId: 'nope' }) })).rejects.toBe(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
