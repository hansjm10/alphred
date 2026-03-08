import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

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

  it('returns 409 when the service reports an invalid recreate state', async () => {
    recreateStoryWorkspaceMock.mockRejectedValue(
      new DashboardIntegrationError(
        'conflict',
        'Story workspace for story id=14 must be removed before it can be recreated.',
        {
          status: 409,
        },
      ),
    );

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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Story workspace for story id=14 must be removed before it can be recreated.',
      },
    });
  });

  it('returns 400 when repositoryId is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/recreate-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 0,
        }),
      }),
      createContext('14'),
    );

    expect(recreateStoryWorkspaceMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "repositoryId" must be a positive integer.',
      },
    });
  });

  it('returns 400 when work item id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/oops/actions/recreate-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
        }),
      }),
      createContext('oops'),
    );

    expect(recreateStoryWorkspaceMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/recreate-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('14'),
    );

    expect(recreateStoryWorkspaceMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Story workspace payload must be valid JSON.',
      },
    });
  });

  it('returns 400 for valid non-object json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/recreate-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '[]',
      }),
      createContext('14'),
    );

    expect(recreateStoryWorkspaceMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Story workspace payload must be a JSON object.',
      },
    });
  });
});
