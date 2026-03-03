import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, proposeStoryBreakdownMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  proposeStoryBreakdownMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/propose-breakdown', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    proposeStoryBreakdownMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      proposeStoryBreakdown: proposeStoryBreakdownMock,
    });
  });

  it('submits a story breakdown proposal', async () => {
    proposeStoryBreakdownMock.mockResolvedValue({
      story: {
        id: 14,
        status: 'BreakdownProposed',
      },
      tasks: [
        {
          id: 15,
          status: 'Draft',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/propose-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
          actorType: 'agent',
          actorLabel: 'planner',
          proposed: {
            tags: ['planning'],
            tasks: [
              {
                title: 'Implement route handlers',
                plannedFiles: ['app/api/dashboard/work-items/[id]/route.ts'],
              },
            ],
          },
        }),
      }),
      createContext('14'),
    );

    expect(proposeStoryBreakdownMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
      expectedRevision: 2,
      actorType: 'agent',
      actorLabel: 'planner',
      proposed: {
        tags: ['planning'],
        tasks: [
          {
            title: 'Implement route handlers',
            plannedFiles: ['app/api/dashboard/work-items/[id]/route.ts'],
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      story: {
        id: 14,
        status: 'BreakdownProposed',
      },
      tasks: [
        {
          id: 15,
          status: 'Draft',
        },
      ],
    });
  });

  it('returns 400 when proposed.tasks is not an array', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/propose-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
          actorType: 'agent',
          actorLabel: 'planner',
          proposed: {
            tasks: 'not-an-array',
          },
        }),
      }),
      createContext('14'),
    );

    expect(proposeStoryBreakdownMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "proposed.tasks" must be an array.',
      },
    });
  });

  it('returns 400 when a proposed task title is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/propose-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
          actorType: 'agent',
          actorLabel: 'planner',
          proposed: {
            tasks: [
              {
                title: 123,
              },
            ],
          },
        }),
      }),
      createContext('14'),
    );

    expect(proposeStoryBreakdownMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "proposed.tasks[0].title" must be a string.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    proposeStoryBreakdownMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Invalid work item transition for type "story".', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/propose-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
          actorType: 'agent',
          actorLabel: 'planner',
          proposed: {
            tasks: [
              {
                title: 'Task A',
              },
            ],
          },
        }),
      }),
      createContext('14'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Invalid work item transition for type "story".',
      },
    });
  });
});
