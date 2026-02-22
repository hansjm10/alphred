import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, listWorkflowCatalogMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkflowCatalogMock: vi.fn(),
}));

vi.mock('../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

describe('loadDashboardWorkflowCatalog', () => {
  beforeEach(() => {
    vi.resetModules();
    createDashboardServiceMock.mockReset();
    listWorkflowCatalogMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkflowCatalog: listWorkflowCatalogMock,
    });
  });

  it('loads workflow catalog via the dashboard service and caches the result', async () => {
    listWorkflowCatalogMock.mockResolvedValue([{ treeKey: 'demo', name: 'Demo', description: null, draftVersion: null, publishedVersion: null, updatedAt: '2026-02-18T00:00:00.000Z' }]);

    const { loadDashboardWorkflowCatalog } = await import('./load-dashboard-workflows');

    await expect(loadDashboardWorkflowCatalog()).resolves.toHaveLength(1);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(1);
    expect(listWorkflowCatalogMock).toHaveBeenCalledTimes(1);
  });
});
