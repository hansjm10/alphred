import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, startTaskWorkflowMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  startTaskWorkflowMock: vi.fn(),
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

describe('POST /api/dashboard/work-items/[id]/actions/start-task-workflow', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    startTaskWorkflowMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      startTaskWorkflow: startTaskWorkflowMock,
    });
  });

  it('starts a task workflow through the dashboard service', async () => {
    startTaskWorkflowMock.mockResolvedValue({
      workItem: {
        id: 9,
        repositoryId: 4,
        status: 'InProgress',
      },
      workflowRunId: 12,
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/start-task-workflow', {
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

    expect(startTaskWorkflowMock).toHaveBeenCalledWith({
      repositoryId: 4,
      workItemId: 9,
      expectedRevision: 2,
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
      workflowRunId: 12,
    });
  });

  it('returns 400 when expectedRevision is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/start-task-workflow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 4,
          actorType: 'human',
          actorLabel: 'alice',
        }),
      }),
      createContext('9'),
    );

    expect(startTaskWorkflowMock).not.toHaveBeenCalled();
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
      new Request('http://localhost/api/dashboard/work-items/oops/actions/start-task-workflow', {
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
      createContext('oops'),
    );

    expect(startTaskWorkflowMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    startTaskWorkflowMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Task id=9 must be Ready before starting a workflow.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/start-task-workflow', {
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

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Task id=9 must be Ready before starting a workflow.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/9/actions/start-task-workflow', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('9'),
    );

    expect(startTaskWorkflowMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Task workflow payload must be valid JSON.',
      },
    });
  });
});
