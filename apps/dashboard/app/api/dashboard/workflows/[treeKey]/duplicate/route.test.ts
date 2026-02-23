import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, duplicateWorkflowTreeMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  duplicateWorkflowTreeMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/workflows/[treeKey]/duplicate', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    duplicateWorkflowTreeMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      duplicateWorkflowTree: duplicateWorkflowTreeMock,
    });
  });

  it('duplicates workflow trees via the dashboard service', async () => {
    duplicateWorkflowTreeMock.mockResolvedValue({
      treeKey: 'copy-tree',
      draftVersion: 1,
    });

    const request = new Request('http://localhost/api/dashboard/workflows/source-tree/duplicate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Copy Tree', treeKey: 'copy-tree' }),
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'source-tree' }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      workflow: {
        treeKey: 'copy-tree',
        draftVersion: 1,
      },
    });
    expect(duplicateWorkflowTreeMock).toHaveBeenCalledTimes(1);
    expect(duplicateWorkflowTreeMock).toHaveBeenCalledWith('source-tree', { name: 'Copy Tree', treeKey: 'copy-tree' });
  });

  it('returns 400 when duplicate payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/source-tree/duplicate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 123, treeKey: 'copy-tree' }),
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'source-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Workflow name must be a string.',
        details: {
          field: 'name',
        },
      },
    });
    expect(duplicateWorkflowTreeMock).not.toHaveBeenCalled();
  });
});
