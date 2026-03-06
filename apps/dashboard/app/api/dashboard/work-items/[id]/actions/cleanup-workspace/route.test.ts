import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, cleanupStoryWorkspaceMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  cleanupStoryWorkspaceMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/cleanup-workspace', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    cleanupStoryWorkspaceMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      cleanupStoryWorkspace: cleanupStoryWorkspaceMock,
    });
  });

  it('cleans up a story workspace', async () => {
    cleanupStoryWorkspaceMock.mockResolvedValue({
      workspace: {
        id: 9,
        repositoryId: 5,
        storyId: 14,
        path: '/tmp/alphred/worktrees/alphred-story-14-a1b2c3',
        branch: 'alphred/story/14-a1b2c3',
        baseBranch: 'main',
        baseCommitHash: 'abc123',
        status: 'removed',
        statusReason: 'cleanup_requested',
        lastReconciledAt: '2026-03-06T00:00:00.000Z',
        removedAt: '2026-03-06T00:00:00.000Z',
        createdAt: '2026-03-05T10:00:00.000Z',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/cleanup-workspace', {
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

    expect(cleanupStoryWorkspaceMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: {
        repositoryId: 5,
        storyId: 14,
        status: 'removed',
        removedAt: '2026-03-06T00:00:00.000Z',
      },
    });
  });
});
