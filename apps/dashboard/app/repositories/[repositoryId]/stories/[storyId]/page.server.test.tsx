// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';
import type {
  DashboardRepositoryState,
  DashboardStoryWorkspaceSnapshot,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';
import StoryDetailPage from './page';

const {
  NOT_FOUND_ERROR,
  createDashboardServiceMock,
  loadGitHubAuthGateMock,
  notFoundMock,
  storyDetailPageContentMock,
} = vi.hoisted(() => {
  const NOT_FOUND_ERROR = new Error('NOT_FOUND');
  return {
    NOT_FOUND_ERROR,
    createDashboardServiceMock: vi.fn(),
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

function createWorkspace(
  overrides: Partial<DashboardStoryWorkspaceSnapshot> = {},
): DashboardStoryWorkspaceSnapshot {
  return {
    id: overrides.id ?? 12,
    repositoryId: overrides.repositoryId ?? 1,
    storyId: overrides.storyId ?? 3,
    path: overrides.path ?? '/tmp/repos/demo-repo/.worktrees/story-3',
    branch: overrides.branch ?? 'alphred/story/3-demo',
    baseBranch: overrides.baseBranch ?? 'main',
    baseCommitHash: overrides.baseCommitHash ?? 'abc123',
    status: overrides.status ?? 'active',
    statusReason: overrides.statusReason ?? null,
    lastReconciledAt: overrides.lastReconciledAt ?? new Date('2026-03-03T00:00:00.000Z').toISOString(),
    removedAt: overrides.removedAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-03-02T00:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-03T00:00:00.000Z').toISOString(),
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
    const workspace = createWorkspace({ repositoryId: repository.id, storyId: story.id });

    createDashboardServiceMock.mockReturnValue({
      getRepository: vi.fn(async () => ({ repository })),
      getRepositoryBoardBootstrap: vi.fn(async () => ({ latestEventId: 7, workItems: [story] })),
      getStoryBreakdownProposal: vi.fn(async () => ({ proposal: null })),
      getStoryWorkspace: vi.fn(async () => ({ workspace })),
    });
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });
    storyDetailPageContentMock.mockImplementation((props: unknown) => (
      <div data-testid="payload">{JSON.stringify(props)}</div>
    ));

    await renderStoryPage({ repositoryId: '1', storyId: '3' });

    const payload = JSON.parse(screen.getByTestId('payload').textContent ?? '{}');
    expect(payload.repository.name).toBe('demo-repo');
    expect(payload.actor.actorLabel).toBe('octocat');
    expect(payload.storyId).toBe(3);
    expect(payload.initialLatestEventId).toBe(7);
    expect(payload.initialWorkItems).toHaveLength(1);
    expect(payload.initialWorkspace.path).toBe(workspace.path);
  });

  it('calls notFound when ids are invalid', async () => {
    createDashboardServiceMock.mockReturnValue({});
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '0', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
    await expect(renderStoryPage({ repositoryId: '1', storyId: 'nope' })).rejects.toBe(NOT_FOUND_ERROR);
  });

  it('calls notFound when repository is missing', async () => {
    createDashboardServiceMock.mockReturnValue({
      getRepository: vi.fn(() => {
        throw new DashboardIntegrationError('not_found', 'Repository id=1 was not found.', {
          status: 404,
        });
      }),
    });
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '1', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
  });

  it('calls notFound when the story is not present in bootstrap work items', async () => {
    const repository = createRepository({ id: 1 });

    createDashboardServiceMock.mockReturnValue({
      getRepository: vi.fn(async () => ({ repository })),
      getRepositoryBoardBootstrap: vi.fn(async () => ({ latestEventId: 0, workItems: [createWorkItem({ id: 5, type: 'task' })] })),
      getStoryBreakdownProposal: vi.fn(async () => ({ proposal: null })),
      getStoryWorkspace: vi.fn(async () => ({ workspace: null })),
    });
    loadGitHubAuthGateMock.mockResolvedValue({ state: 'authenticated', user: 'octocat' });

    await expect(renderStoryPage({ repositoryId: '1', storyId: '3' })).rejects.toBe(NOT_FOUND_ERROR);
  });
});
