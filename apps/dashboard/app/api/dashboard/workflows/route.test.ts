import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, listWorkflowTreesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkflowTreesMock: vi.fn(),
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/workflows', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listWorkflowTreesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkflowTrees: listWorkflowTreesMock,
    });
  });

  it('returns workflow trees from the dashboard service', async () => {
    listWorkflowTreesMock.mockResolvedValue([
      {
        id: 10,
        key: 'default',
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflows: [
        {
          id: 10,
          key: 'default',
        },
      ],
    });
    expect(listWorkflowTreesMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    listWorkflowTreesMock.mockRejectedValue(new Error('workflow query failed'));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
      },
    });
  });
});
