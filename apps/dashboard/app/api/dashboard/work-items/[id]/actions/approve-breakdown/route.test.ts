import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '../../../../../../../src/server/dashboard-errors';

const { createDashboardServiceMock, approveStoryBreakdownMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  approveStoryBreakdownMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/approve-breakdown', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    approveStoryBreakdownMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      approveStoryBreakdown: approveStoryBreakdownMock,
    });
  });

  it('approves a story breakdown', async () => {
    approveStoryBreakdownMock.mockResolvedValue({
      story: {
        id: 14,
        status: 'Approved',
      },
      tasks: [
        {
          id: 15,
          status: 'Ready',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/approve-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 3,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('14'),
    );

    expect(approveStoryBreakdownMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
      expectedRevision: 3,
      actorType: 'human',
      actorLabel: 'alice',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      story: {
        id: 14,
        status: 'Approved',
      },
      tasks: [
        {
          id: 15,
          status: 'Ready',
        },
      ],
    });
  });

  it('returns 400 when expectedRevision is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/approve-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('14'),
    );

    expect(approveStoryBreakdownMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "expectedRevision" must be a non-negative integer.',
      },
    });
  });

  it('returns 400 when work item id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/oops/actions/approve-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 3,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('oops'),
    );

    expect(approveStoryBreakdownMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    approveStoryBreakdownMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Cannot approve breakdown without child tasks.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/approve-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 3,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('14'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Cannot approve breakdown without child tasks.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/approve-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('14'),
    );

    expect(approveStoryBreakdownMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Work item breakdown approval payload must be valid JSON.',
      },
    });
  });
});
