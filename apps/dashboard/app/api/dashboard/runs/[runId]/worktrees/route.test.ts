import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getRunWorktreesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRunWorktreesMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/runs/[runId]/worktrees', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRunWorktreesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRunWorktrees: getRunWorktreesMock,
    });
  });

  it('returns run worktrees for a valid runId', async () => {
    getRunWorktreesMock.mockResolvedValue([
      {
        id: 21,
        path: '/tmp/wt-21',
      },
    ]);

    const response = await GET(new Request('http://localhost/api/dashboard/runs/21/worktrees'), {
      params: Promise.resolve({ runId: '21' }),
    });

    expect(getRunWorktreesMock).toHaveBeenCalledWith(21);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      worktrees: [
        {
          id: 21,
          path: '/tmp/wt-21',
        },
      ],
    });
  });

  it('returns a 400 response when runId is invalid', async () => {
    const response = await GET(new Request('http://localhost/api/dashboard/runs/zero/worktrees'), {
      params: Promise.resolve({ runId: '0' }),
    });

    expect(getRunWorktreesMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runId must be a positive integer.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    getRunWorktreesMock.mockRejectedValue(new Error('worktree fetch failed'));

    const response = await GET(new Request('http://localhost/api/dashboard/runs/21/worktrees'), {
      params: Promise.resolve({ runId: '21' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'worktree fetch failed',
        },
      },
    });
  });
});
