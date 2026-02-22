import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, listWorkflowCatalogMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkflowCatalogMock: vi.fn(),
}));

vi.mock('../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/workflows/catalog', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listWorkflowCatalogMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkflowCatalog: listWorkflowCatalogMock,
    });
  });

  it('returns the workflow catalog from the dashboard service', async () => {
    listWorkflowCatalogMock.mockResolvedValue([
      {
        treeKey: 'demo-tree',
        name: 'Demo Tree',
        description: null,
        publishedVersion: 1,
        draftVersion: null,
        updatedAt: '2026-02-21T06:30:50.000Z',
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflows: [
        {
          treeKey: 'demo-tree',
          name: 'Demo Tree',
          description: null,
          publishedVersion: 1,
          draftVersion: null,
          updatedAt: '2026-02-21T06:30:50.000Z',
        },
      ],
    });
    expect(listWorkflowCatalogMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    listWorkflowCatalogMock.mockRejectedValue(new Error('catalog failed'));

    const response = await GET();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'catalog failed',
        },
      },
    });
  });
});
