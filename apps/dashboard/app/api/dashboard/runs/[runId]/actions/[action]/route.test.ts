import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, controlWorkflowRunMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  controlWorkflowRunMock: vi.fn(),
}));

vi.mock('../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/runs/[runId]/actions/[action]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    controlWorkflowRunMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      controlWorkflowRun: controlWorkflowRunMock,
    });
  });

  it('controls a run lifecycle action for a valid run id and action', async () => {
    controlWorkflowRunMock.mockResolvedValue({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: 11,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });

    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/pause', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'pause' }),
    });

    expect(controlWorkflowRunMock).toHaveBeenCalledWith(11, 'pause');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: 'pause',
      outcome: 'applied',
      workflowRunId: 11,
      previousRunStatus: 'running',
      runStatus: 'paused',
      retriedRunNodeIds: [],
    });
  });

  it('returns 400 when runId is invalid', async () => {
    const response = await POST(new Request('http://localhost/api/dashboard/runs/invalid/actions/pause', { method: 'POST' }), {
      params: Promise.resolve({ runId: 'invalid', action: 'pause' }),
    });

    expect(controlWorkflowRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runId must be a positive integer.',
      },
    });
  });

  it('returns 400 when action is unsupported', async () => {
    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/start', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'start' }),
    });

    expect(controlWorkflowRunMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'action must be one of: cancel, pause, resume, retry.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    controlWorkflowRunMock.mockRejectedValue(new Error('control failed'));

    const response = await POST(new Request('http://localhost/api/dashboard/runs/11/actions/cancel', { method: 'POST' }), {
      params: Promise.resolve({ runId: '11', action: 'cancel' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'control failed',
        },
      },
    });
  });
});
