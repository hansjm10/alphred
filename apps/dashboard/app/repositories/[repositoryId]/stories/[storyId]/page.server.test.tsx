// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import StoryDetailPage from './page';

const {
  NOT_FOUND_ERROR,
  createDashboardServiceMock,
  loadDashboardRepositoriesMock,
  loadGitHubAuthGateMock,
  notFoundMock,
  storyDetailPageContentMock,
} = vi.hoisted(() => {
  const NOT_FOUND_ERROR = new Error('NOT_FOUND');
  return {
    NOT_FOUND_ERROR,
    createDashboardServiceMock: vi.fn(),
    loadDashboardRepositoriesMock: vi.fn(),
    loadGitHubAuthGateMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw NOT_FOUND_ERROR;
    }),
    storyDetailPageContentMock: vi.fn(),
  };
});

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('../../../load-dashboard-repositories', () => ({
  loadDashboardRepositories: loadDashboardRepositoriesMock,
}));

vi.mock('../../../../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

vi.mock('./story-detail-client', () => ({
  StoryDetailPageContent: storyDetailPageContentMock,
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
    id: overrides.id ?? 3,
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

async function renderStoryPage(params: { repositoryId: string; storyId: string }) {
  const element = await StoryDetailPage({ params: Promise.resolve(params) });
  render(element);
}

describe('StoryDetailPage', () => {
  it('boots the story detail client with repository + actor + bootstrap data', async () => {
    const repository = createRepository({ id: 1, name: 'demo-repo' });
    const story = createWorkItem({ id: 3, type: 'story' });

    createDashboardServiceMock.mockReturnValue({
      getRepositoryBoardBootstrap: vi.fn(async () => ({ latestEventId: 7, workItems: [story] })),
      getStoryBreakdownProposal: vi.fn(async () => ({ proposal: null })),
      getStoryWorkspace: vi.fn(async () => ({ workspace: null })),
    });
    loadDashboardRepositoriesMock.mockResolvedValue([repository]);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });
    storyDetailPageContentMock.mockImplementation((props: unknown) => (
      <div data-testid="payload">{JSON.stringify(props)}</div>
    ));

    await renderStoryPage({ repositoryId: '1', storyId: '3' });

    expect(loadDashboardRepositoriesMock).toHaveBeenCalledWith(false);
    const payload = JSON.parse(screen.getByTestId('payload').textContent ?? '{}');
    expect(payload.repository.name).toBe('demo-repo');
    expect(payload.actor.actorLabel).toBe('octocat');
    expect(payload.storyId).toBe(3);
    expect(payload.initialLatestEventId).toBe(7);
    expect(payload.initialWorkItems).toHaveLength(1);
    expect(payload.initialWorkspace).toBeNull();
  });

  it('calls notFound when ids are invalid', async () => {
    createDashboardServiceMock.mockReturnValue({});
    loadDashboardRepositoriesMock.mockResolvedValue([]);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '0', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
    await expect(renderStoryPage({ repositoryId: '1', storyId: 'nope' })).rejects.toBe(NOT_FOUND_ERROR);
  });

  it('calls notFound when repository is missing', async () => {
    createDashboardServiceMock.mockReturnValue({});
    loadDashboardRepositoriesMock.mockResolvedValue([createRepository({ id: 2 })]);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '1', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
  });

  it('calls notFound when the story is not present in bootstrap work items', async () => {
    const repository = createRepository({ id: 1 });

    createDashboardServiceMock.mockReturnValue({
      getRepositoryBoardBootstrap: vi.fn(async () => ({ latestEventId: 0, workItems: [createWorkItem({ id: 5, type: 'task' })] })),
      getStoryBreakdownProposal: vi.fn(async () => ({ proposal: null })),
      getStoryWorkspace: vi.fn(async () => ({ workspace: null })),
    });
    loadDashboardRepositoriesMock.mockResolvedValue([repository]);
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '1', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
  });
});
