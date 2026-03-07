import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, reconcileStoryWorkspaceMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  reconcileStoryWorkspaceMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/reconcile-workspace', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    reconcileStoryWorkspaceMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      reconcileStoryWorkspace: reconcileStoryWorkspaceMock,
    });
  });

  it('reconciles a story workspace', async () => {
    reconcileStoryWorkspaceMock.mockResolvedValue({
      workspace: {
        id: 9,
        repositoryId: 5,
        storyId: 14,
        path: '/tmp/alphred/worktrees/alphred-story-14-a1b2c3',
        branch: 'alphred/story/14-a1b2c3',
        baseBranch: 'main',
        baseCommitHash: 'abc123',
        status: 'stale',
        statusReason: 'missing_path',
        lastReconciledAt: '2026-03-06T00:00:00.000Z',
        removedAt: null,
        createdAt: '2026-03-05T10:00:00.000Z',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/reconcile-workspace', {
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

    expect(reconcileStoryWorkspaceMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: {
        repositoryId: 5,
        storyId: 14,
        status: 'stale',
      },
    });
  });

  it('returns 404 when the service reports that no workspace exists', async () => {
    reconcileStoryWorkspaceMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Story workspace for story id=14 was not found.', {
        status: 404,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/reconcile-workspace', {
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

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: 'Story workspace for story id=14 was not found.',
      },
    });
  });

  it('returns 400 when repositoryId is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/reconcile-workspace', {
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

    expect(reconcileStoryWorkspaceMock).not.toHaveBeenCalled();
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
      new Request('http://localhost/api/dashboard/work-items/oops/actions/reconcile-workspace', {
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

    expect(reconcileStoryWorkspaceMock).not.toHaveBeenCalled();
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
      new Request('http://localhost/api/dashboard/work-items/14/actions/reconcile-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('14'),
    );

    expect(reconcileStoryWorkspaceMock).not.toHaveBeenCalled();
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
      new Request('http://localhost/api/dashboard/work-items/14/actions/reconcile-workspace', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '[]',
      }),
      createContext('14'),
    );

    expect(reconcileStoryWorkspaceMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Story workspace payload must be a JSON object.',
      },
    });
  });
});
