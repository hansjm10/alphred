import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, listRepositoriesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listRepositoriesMock: vi.fn(),
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/repositories', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listRepositoriesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listRepositories: listRepositoriesMock,
    });
  });

  it('returns repositories from the dashboard service', async () => {
    listRepositoriesMock.mockResolvedValue([
      {
        id: 1,
        name: 'demo',
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositories: [
        {
          id: 1,
          name: 'demo',
        },
      ],
    });
    expect(listRepositoriesMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    listRepositoriesMock.mockRejectedValue(new Error('cannot connect'));

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
