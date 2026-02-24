import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getRunNodeStreamSnapshotMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRunNodeStreamSnapshotMock: vi.fn(),
}));

vi.mock('../../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/runs/[runId]/nodes/[runNodeId]/stream', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRunNodeStreamSnapshotMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRunNodeStreamSnapshot: getRunNodeStreamSnapshotMock,
    });
  });

  it('returns run-node stream snapshot for a valid request', async () => {
    getRunNodeStreamSnapshotMock.mockResolvedValue({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      nodeStatus: 'running',
      ended: false,
      latestSequence: 7,
      events: [],
    });

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream?attempt=2&lastEventSequence=3'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).toHaveBeenCalledWith({
      runId: 11,
      runNodeId: 4,
      attempt: 2,
      lastEventSequence: 3,
      limit: undefined,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflowRunId: 11,
      runNodeId: 4,
      attempt: 2,
      nodeStatus: 'running',
      ended: false,
      latestSequence: 7,
      events: [],
    });
  });

  it('returns 400 when attempt query is missing', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'attempt must be a positive integer.',
      },
    });
  });

  it('returns 400 when runNodeId is invalid', async () => {
    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/not-a-number/stream?attempt=1'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: 'not-a-number' }),
      },
    );

    expect(getRunNodeStreamSnapshotMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'runNodeId must be a positive integer.',
      },
    });
  });

  it('maps service failures to integration error responses', async () => {
    getRunNodeStreamSnapshotMock.mockRejectedValue(new Error('snapshot lookup failed'));

    const response = await GET(
      new Request('http://localhost/api/dashboard/runs/11/nodes/4/stream?attempt=1'),
      {
        params: Promise.resolve({ runId: '11', runNodeId: '4' }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'snapshot lookup failed',
        },
      },
    });
  });
});
