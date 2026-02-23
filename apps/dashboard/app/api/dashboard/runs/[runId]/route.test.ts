import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getWorkflowRunDetailMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getWorkflowRunDetailMock: vi.fn(),
}));

vi.mock('../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/runs/[runId]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getWorkflowRunDetailMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getWorkflowRunDetail: getWorkflowRunDetailMock,
    });
  });

  it('returns run detail for a valid runId', async () => {
    getWorkflowRunDetailMock.mockResolvedValue({
      id: 11,
      status: 'running',
    });

    const response = await GET(new Request('http://localhost/api/dashboard/runs/11'), {
      params: Promise.resolve({ runId: '11' }),
    });

    expect(getWorkflowRunDetailMock).toHaveBeenCalledWith(11);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 11,
      status: 'running',
    });
  });

  it('returns a 400 response when runId is invalid', async () => {
    const response = await GET(new Request('http://localhost/api/dashboard/runs/not-a-number'), {
      params: Promise.resolve({ runId: 'not-a-number' }),
    });

    expect(getWorkflowRunDetailMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runId must be a positive integer.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    getWorkflowRunDetailMock.mockRejectedValue(new Error('lookup failed'));

    const response = await GET(new Request('http://localhost/api/dashboard/runs/11'), {
      params: Promise.resolve({ runId: '11' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'lookup failed',
        },
      },
    });
  });
});
