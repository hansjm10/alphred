import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, isWorkflowTreeKeyAvailableMock, listWorkflowCatalogMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  isWorkflowTreeKeyAvailableMock: vi.fn(),
  listWorkflowCatalogMock: vi.fn(),
}));

vi.mock('../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/workflows/catalog', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    isWorkflowTreeKeyAvailableMock.mockReset();
    listWorkflowCatalogMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      isWorkflowTreeKeyAvailable: isWorkflowTreeKeyAvailableMock,
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

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/catalog'));

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
    expect(isWorkflowTreeKeyAvailableMock).not.toHaveBeenCalled();
  });

  it('checks tree-key availability when treeKey query param is provided', async () => {
    isWorkflowTreeKeyAvailableMock.mockResolvedValue({
      treeKey: 'demo-tree',
      available: false,
    });

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/catalog?treeKey=demo-tree'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      treeKey: 'demo-tree',
      available: false,
    });
    expect(isWorkflowTreeKeyAvailableMock).toHaveBeenCalledWith('demo-tree');
    expect(listWorkflowCatalogMock).not.toHaveBeenCalled();
  });

  it('maps service failures to integration error responses', async () => {
    listWorkflowCatalogMock.mockRejectedValue(new Error('catalog failed'));

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/catalog'));

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

  it('maps availability validation failures to integration error responses', async () => {
    isWorkflowTreeKeyAvailableMock.mockRejectedValue(new Error('invalid tree key'));

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/catalog?treeKey=Bad Key'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'invalid tree key',
      },
    });
  });
});
