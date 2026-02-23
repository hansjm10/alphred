// @vitest-environment jsdom

import { isValidElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkflowsPage from './page';

const { loadDashboardWorkflowCatalogMock } = vi.hoisted(() => ({
  loadDashboardWorkflowCatalogMock: vi.fn(),
}));

vi.mock('./load-dashboard-workflows', () => ({
  loadDashboardWorkflowCatalog: loadDashboardWorkflowCatalogMock,
}));

describe('WorkflowsPage', () => {
  beforeEach(() => {
    loadDashboardWorkflowCatalogMock.mockReset();
  });

  it('uses provided workflows without calling the loader', async () => {
    const element = await WorkflowsPage({
      workflows: [
        {
          treeKey: 'demo',
          name: 'Demo',
          description: null,
          publishedVersion: null,
          draftVersion: null,
          updatedAt: '2026-02-18T00:00:00.000Z',
        },
      ],
    });

    expect(loadDashboardWorkflowCatalogMock).not.toHaveBeenCalled();
    expect(isValidElement(element)).toBe(true);
  });

  it('loads workflows when none are provided', async () => {
    loadDashboardWorkflowCatalogMock.mockResolvedValue([
      {
        treeKey: 'demo',
        name: 'Demo',
        description: null,
        publishedVersion: null,
        draftVersion: null,
        updatedAt: '2026-02-18T00:00:00.000Z',
      },
    ]);

    const element = await WorkflowsPage();

    expect(loadDashboardWorkflowCatalogMock).toHaveBeenCalledTimes(1);
    expect(isValidElement(element)).toBe(true);
  });
});
