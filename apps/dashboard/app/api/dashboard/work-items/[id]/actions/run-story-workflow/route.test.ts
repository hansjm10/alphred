import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, runStoryWorkflowMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  runStoryWorkflowMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/run-story-workflow', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    runStoryWorkflowMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      runStoryWorkflow: runStoryWorkflowMock,
    });
  });

  it('runs story workflow orchestration through the dashboard service', async () => {
    runStoryWorkflowMock.mockResolvedValue({
      story: {
        id: 14,
        status: 'Approved',
      },
      updatedTasks: [
        {
          id: 15,
          status: 'InProgress',
        },
      ],
      startedTasks: [
        {
          id: 15,
          status: 'InProgress',
        },
      ],
      steps: [
        {
          step: 'approve_breakdown',
          outcome: 'applied',
          message: 'Approved breakdown.',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/run-story-workflow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 3,
          actorType: 'human',
          actorLabel: 'alice',
          approveAndStart: true,
        }),
      }),
      createContext('14'),
    );

    expect(runStoryWorkflowMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
      expectedRevision: 3,
      actorType: 'human',
      actorLabel: 'alice',
      approveAndStart: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      story: {
        id: 14,
        status: 'Approved',
      },
      updatedTasks: [
        {
          id: 15,
          status: 'InProgress',
        },
      ],
      startedTasks: [
        {
          id: 15,
          status: 'InProgress',
        },
      ],
      steps: [
        {
          step: 'approve_breakdown',
          outcome: 'applied',
          message: 'Approved breakdown.',
        },
      ],
    });
  });

  it('returns 400 when expectedRevision is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/run-story-workflow', {
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

    expect(runStoryWorkflowMock).not.toHaveBeenCalled();
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
      new Request('http://localhost/api/dashboard/work-items/oops/actions/run-story-workflow', {
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

    expect(runStoryWorkflowMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    runStoryWorkflowMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Story is waiting for a breakdown proposal.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/run-story-workflow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 3,
          actorType: 'human',
          actorLabel: 'alice',
          generateOnly: true,
        }),
      }),
      createContext('14'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Story is waiting for a breakdown proposal.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/run-story-workflow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('14'),
    );

    expect(runStoryWorkflowMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Story workflow payload must be valid JSON.',
      },
    });
  });
});
