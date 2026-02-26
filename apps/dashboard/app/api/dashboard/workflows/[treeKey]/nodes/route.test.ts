import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';

const { createDashboardServiceMock, listPublishedTreeNodesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listPublishedTreeNodesMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('GET /api/dashboard/workflows/[treeKey]/nodes', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listPublishedTreeNodesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listPublishedTreeNodes: listPublishedTreeNodesMock,
    });
  });

  it('returns node options for a published workflow tree', async () => {
    listPublishedTreeNodesMock.mockResolvedValue([
      { nodeKey: 'design', displayName: 'Design' },
      { nodeKey: 'implement', displayName: 'Implement' },
    ]);

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/nodes', {
      method: 'GET',
    });

    const response = await GET(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      nodes: [
        { nodeKey: 'design', displayName: 'Design' },
        { nodeKey: 'implement', displayName: 'Implement' },
      ],
    });
    expect(listPublishedTreeNodesMock).toHaveBeenCalledWith('demo-tree');
  });

  it('returns error response when published tree is not found', async () => {
    listPublishedTreeNodesMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Published workflow tree "missing-tree" was not found.', {
        status: 404,
      }),
    );

    const request = new Request('http://localhost/api/dashboard/workflows/missing-tree/nodes', {
      method: 'GET',
    });

    const response = await GET(request, { params: Promise.resolve({ treeKey: 'missing-tree' }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: 'Published workflow tree "missing-tree" was not found.',
      },
    });
  });
});
