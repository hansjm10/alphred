import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getStoryBreakdownProposalMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getStoryBreakdownProposalMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

function createContext(id: string): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe('Route /api/dashboard/work-items/[id]/breakdown', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getStoryBreakdownProposalMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getStoryBreakdownProposal: getStoryBreakdownProposalMock,
    });
  });

  it('returns breakdown proposal when repositoryId and id are valid', async () => {
    getStoryBreakdownProposalMock.mockResolvedValue({
      proposal: {
        eventId: 99,
        createdAt: new Date('2026-03-02T00:00:00.000Z').toISOString(),
        createdTaskIds: [12],
        proposed: { tags: null, plannedFiles: ['src/a.ts'], links: null, tasks: [{ title: 'Do thing' }] },
      },
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/work-items/14/breakdown?repositoryId=4'),
      createContext('14'),
    );

    expect(getStoryBreakdownProposalMock).toHaveBeenCalledWith({ repositoryId: 4, storyId: 14 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      proposal: {
        eventId: 99,
        createdAt: new Date('2026-03-02T00:00:00.000Z').toISOString(),
        createdTaskIds: [12],
        proposed: { tags: null, plannedFiles: ['src/a.ts'], links: null, tasks: [{ title: 'Do thing' }] },
      },
    });
  });

  it('returns 400 when repositoryId query param is missing', async () => {
    const response = await GET(new Request('http://localhost/api/dashboard/work-items/14/breakdown'), createContext('14'));

    expect(getStoryBreakdownProposalMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "repositoryId" must be a positive integer.',
      },
    });
  });

  it('returns 400 when work item id path segment is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/work-items/nope/breakdown?repositoryId=4'),
      createContext('nope'),
    );

    expect(getStoryBreakdownProposalMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });
});
