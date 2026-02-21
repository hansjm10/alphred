import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, createWorkflowDraftMock, listWorkflowTreesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  createWorkflowDraftMock: vi.fn(),
  listWorkflowTreesMock: vi.fn(),
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, POST } from './route';

describe('GET /api/dashboard/workflows', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    createWorkflowDraftMock.mockReset();
    listWorkflowTreesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      createWorkflowDraft: createWorkflowDraftMock,
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
	        details: {
	          cause: 'workflow query failed',
	        },
	      },
	    });
	  });
	});

describe('POST /api/dashboard/workflows', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    createWorkflowDraftMock.mockReset();
    listWorkflowTreesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      createWorkflowDraft: createWorkflowDraftMock,
      listWorkflowTrees: listWorkflowTreesMock,
    });
  });

  it('creates workflow drafts via the dashboard service', async () => {
    createWorkflowDraftMock.mockResolvedValue({
      treeKey: 'new-tree',
      draftVersion: 1,
    });

    const request = new Request('http://localhost/api/dashboard/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template: 'blank', name: 'New Tree', treeKey: 'new-tree' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      workflow: {
        treeKey: 'new-tree',
        draftVersion: 1,
      },
    });
    expect(createWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });
});
