import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getStoryBreakdownRunMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getStoryBreakdownRunMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

function createContext(id: string, runId: string): { params: Promise<{ id: string; runId: string }> } {
  return {
    params: Promise.resolve({ id, runId }),
  };
}

describe('Route /api/dashboard/work-items/[id]/breakdown/runs/[runId]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getStoryBreakdownRunMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getStoryBreakdownRun: getStoryBreakdownRunMock,
    });
  });

  it('returns breakdown run state for valid repository, story, and run ids', async () => {
    getStoryBreakdownRunMock.mockResolvedValue({
      workflowRunId: 88,
      runStatus: 'completed',
      result: {
        schemaVersion: 1,
        resultType: 'story_breakdown_result',
        proposed: {
          tags: ['story'],
          plannedFiles: ['README.md'],
          links: ['https://example.com/story'],
          tasks: [{ title: 'Implement contract' }],
        },
      },
      error: null,
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown/runs/88?repositoryId=4'),
      createContext('14', '88'),
    );

    expect(getStoryBreakdownRunMock).toHaveBeenCalledWith({
      repositoryId: 4,
      storyId: 14,
      workflowRunId: 88,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflowRunId: 88,
      runStatus: 'completed',
      result: {
        schemaVersion: 1,
        resultType: 'story_breakdown_result',
        proposed: {
          tags: ['story'],
          plannedFiles: ['README.md'],
          links: ['https://example.com/story'],
          tasks: [{ title: 'Implement contract' }],
        },
      },
      error: null,
    });
  });

  it('returns 400 when repositoryId is missing', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown/runs/88'),
      createContext('14', '88'),
    );

    expect(getStoryBreakdownRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "repositoryId" must be a positive integer.',
      },
    });
  });

  it('returns 400 when runId is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown/runs/oops?repositoryId=4'),
      createContext('14', 'oops'),
    );

    expect(getStoryBreakdownRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runId must be a positive integer.',
      },
    });
  });
});
