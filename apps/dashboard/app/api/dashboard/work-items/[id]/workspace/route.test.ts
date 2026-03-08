import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, getStoryWorkspaceMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getStoryWorkspaceMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('Route /api/dashboard/work-items/[id]/workspace', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getStoryWorkspaceMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getStoryWorkspace: getStoryWorkspaceMock,
    });
  });

  it('returns the story workspace snapshot', async () => {
    getStoryWorkspaceMock.mockResolvedValue({
      workspace: {
        id: 14,
        repositoryId: 3,
        storyId: 11,
        path: '/tmp/repos/demo/.worktrees/story-11',
        branch: 'alphred/story/11-demo',
        baseBranch: 'main',
        baseCommitHash: 'abc123',
        status: 'active',
        statusReason: null,
        lastReconciledAt: '2026-03-08T00:00:00.000Z',
        removedAt: null,
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-08T00:00:00.000Z',
      },
    });

    const response = await GET(new Request('http://localhost/api/dashboard/work-items/11/workspace?repositoryId=3'), {
      params: Promise.resolve({ id: '11' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspace: {
        id: 14,
        repositoryId: 3,
        storyId: 11,
        path: '/tmp/repos/demo/.worktrees/story-11',
        branch: 'alphred/story/11-demo',
        baseBranch: 'main',
        baseCommitHash: 'abc123',
        status: 'active',
        statusReason: null,
        lastReconciledAt: '2026-03-08T00:00:00.000Z',
        removedAt: null,
        createdAt: '2026-03-07T00:00:00.000Z',
        updatedAt: '2026-03-08T00:00:00.000Z',
      },
    });
    expect(getStoryWorkspaceMock).toHaveBeenCalledWith({
      repositoryId: 3,
      storyId: 11,
    });
  });

  it('returns 400 when repositoryId is missing', async () => {
    const response = await GET(new Request('http://localhost/api/dashboard/work-items/11/workspace'), {
      params: Promise.resolve({ id: '11' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "repositoryId" must be a positive integer.',
      },
    });
    expect(getStoryWorkspaceMock).not.toHaveBeenCalled();
  });

  it('maps service failures to integration error responses', async () => {
    getStoryWorkspaceMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Story workspace for story id=11 was not found.', {
        status: 404,
      }),
    );

    const response = await GET(new Request('http://localhost/api/dashboard/work-items/11/workspace?repositoryId=3'), {
      params: Promise.resolve({ id: '11' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: 'Story workspace for story id=11 was not found.',
      },
    });
  });
});
