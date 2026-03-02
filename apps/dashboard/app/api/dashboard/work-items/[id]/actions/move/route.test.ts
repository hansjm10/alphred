import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '../../../../../../../src/server/dashboard-errors';

const { createDashboardServiceMock, moveWorkItemStatusMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  moveWorkItemStatusMock: vi.fn(),
}));

vi.mock('../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

function createContext(id: string): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe('POST /api/dashboard/work-items/[id]/actions/move', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    moveWorkItemStatusMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      moveWorkItemStatus: moveWorkItemStatusMock,
    });
  });

  it('moves a work item status through the dashboard service', async () => {
    moveWorkItemStatusMock.mockResolvedValue({
      workItem: {
        id: 9,
        repositoryId: 4,
        status: 'InProgress',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/move', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
          toStatus: 'InProgress',
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('9'),
    );

    expect(moveWorkItemStatusMock).toHaveBeenCalledWith({
      repositoryId: 4,
      workItemId: 9,
      expectedRevision: 2,
      toStatus: 'InProgress',
      actorType: 'human',
      actorLabel: 'alice',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workItem: {
        id: 9,
        repositoryId: 4,
        status: 'InProgress',
      },
    });
  });

  it('returns 400 when toStatus is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/move', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('9'),
    );

    expect(moveWorkItemStatusMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "toStatus" must be a valid work-item status string.',
      },
    });
  });

  it('returns 400 when work item id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/oops/actions/move', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
          toStatus: 'InProgress',
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('oops'),
    );

    expect(moveWorkItemStatusMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    moveWorkItemStatusMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Invalid work item transition.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/move', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 4,
          expectedRevision: 2,
          toStatus: 'InProgress',
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('9'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Invalid work item transition.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/move', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('9'),
    );

    expect(moveWorkItemStatusMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Work item move payload must be valid JSON.',
      },
    });
  });
});
