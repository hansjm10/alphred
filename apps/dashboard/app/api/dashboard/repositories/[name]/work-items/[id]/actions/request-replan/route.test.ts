import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, requestWorkItemReplanMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  requestWorkItemReplanMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

function createContext(name: string, id: string): { params: Promise<{ name: string; id: string }> } {
  return {
    params: Promise.resolve({ name, id }),
  };
}

describe('POST /api/dashboard/repositories/[name]/work-items/[id]/actions/request-replan', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    requestWorkItemReplanMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      requestWorkItemReplan: requestWorkItemReplanMock,
    });
  });

  it('requests replanning through the dashboard service', async () => {
    requestWorkItemReplanMock.mockResolvedValue({
      repositoryId: 4,
      workItemId: 9,
      workflowRunId: 22,
      eventId: 31,
      requestedAt: '2026-03-03T00:01:00.000Z',
      plannedButUntouched: ['src/planned.ts'],
      touchedButUnplanned: ['src/actual.ts'],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/4/work-items/9/actions/request-replan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('4', '9'),
    );

    expect(requestWorkItemReplanMock).toHaveBeenCalledWith({
      repositoryId: 4,
      workItemId: 9,
      actorType: 'human',
      actorLabel: 'alice',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositoryId: 4,
      workItemId: 9,
      workflowRunId: 22,
      eventId: 31,
      requestedAt: '2026-03-03T00:01:00.000Z',
      plannedButUntouched: ['src/planned.ts'],
      touchedButUnplanned: ['src/actual.ts'],
    });
  });

  it('returns 400 when actorType is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/4/work-items/9/actions/request-replan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          actorLabel: 'alice',
        }),
      }),
      createContext('4', '9'),
    );

    expect(requestWorkItemReplanMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "actorType" must be one of: human, agent, system.',
      },
    });
  });

  it('returns 400 when repository id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/nope/work-items/9/actions/request-replan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('nope', '9'),
    );

    expect(requestWorkItemReplanMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'repositoryId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    requestWorkItemReplanMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Task is not linked to a workflow run.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/4/work-items/9/actions/request-replan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('4', '9'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Task is not linked to a workflow run.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/4/work-items/9/actions/request-replan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"actorType":',
      }),
      createContext('4', '9'),
    );

    expect(requestWorkItemReplanMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Work item replan payload must be valid JSON.',
      },
    });
  });
});
