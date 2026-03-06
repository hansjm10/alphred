import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, launchStoryBreakdownRunMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  launchStoryBreakdownRunMock: vi.fn(),
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

describe('Route /api/dashboard/work-items/[id]/breakdown/runs', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    launchStoryBreakdownRunMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      launchStoryBreakdownRun: launchStoryBreakdownRunMock,
    });
  });

  it('launches a story breakdown run for a valid payload', async () => {
    launchStoryBreakdownRunMock.mockResolvedValue({
      workflowRunId: 77,
      mode: 'async',
      status: 'accepted',
      runStatus: 'pending',
      result: null,
      error: null,
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown/runs', {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
        }),
      }),
      createContext('14'),
    );

    expect(launchStoryBreakdownRunMock).toHaveBeenCalledWith({
      repositoryId: 4,
      storyId: 14,
      expectedRevision: 2,
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      workflowRunId: 77,
      mode: 'async',
      status: 'accepted',
      runStatus: 'pending',
      result: null,
      error: null,
    });
  });

  it('returns 400 when the story id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/nope/breakdown/runs', {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
        }),
      }),
      createContext('nope'),
    );

    expect(launchStoryBreakdownRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 400 when the request body is malformed', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown/runs', {
        method: 'POST',
        body: '{invalid',
      }),
      createContext('14'),
    );

    expect(launchStoryBreakdownRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Breakdown run launch payload must be valid JSON.',
      },
    });
  });
});
