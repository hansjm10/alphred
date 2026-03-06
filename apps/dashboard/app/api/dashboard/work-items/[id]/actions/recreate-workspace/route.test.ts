import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, recreateStoryWorkspaceMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  recreateStoryWorkspaceMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

function createContext(id: string): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe('POST /api/dashboard/work-items/[id]/actions/recreate-workspace', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    recreateStoryWorkspaceMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      recreateStoryWorkspace: recreateStoryWorkspaceMock,
    });
  });

  it('recreates a story workspace', async () => {
    recreateStoryWorkspaceMock.mockResolvedValue({
      workspace: {
        id: 9,
        repositoryId: 5,
        storyId: 14,
        path: '/tmp/alphred/worktrees/alphred-story-14-d4e5f6',
        branch: 'alphred/story/14-d4e5f6',
        baseBranch: 'main',
        baseCommitHash: 'def456',
        status: 'active',
        statusReason: null,
        lastReconciledAt: '2026-03-06T00:05:00.000Z',
        removedAt: null,
        createdAt: '2026-03-05T10:00:00.000Z',
        updatedAt: '2026-03-06T00:05:00.000Z',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/recreate-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
        }),
      }),
      createContext('14'),
    );

    expect(recreateStoryWorkspaceMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: {
        repositoryId: 5,
        storyId: 14,
        status: 'active',
        branch: 'alphred/story/14-d4e5f6',
      },
    });
  });
});
