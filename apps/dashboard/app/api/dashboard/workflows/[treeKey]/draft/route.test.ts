import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getOrCreateWorkflowDraftMock, saveWorkflowDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getOrCreateWorkflowDraftMock: vi.fn(),
  saveWorkflowDraftMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, PUT } from './route';

describe('GET /api/dashboard/workflows/[treeKey]/draft', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getOrCreateWorkflowDraftMock.mockReset();
    saveWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getOrCreateWorkflowDraft: getOrCreateWorkflowDraftMock,
      saveWorkflowDraft: saveWorkflowDraftMock,
    });
  });

  it('returns the workflow draft topology from the dashboard service', async () => {
    getOrCreateWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 2,
      name: 'Demo Tree',
      description: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/demo-tree/draft'), {
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: {
        treeKey: 'demo-tree',
        version: 2,
        name: 'Demo Tree',
        description: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
    });
    expect(getOrCreateWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/dashboard/workflows/[treeKey]/draft', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getOrCreateWorkflowDraftMock.mockReset();
    saveWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getOrCreateWorkflowDraft: getOrCreateWorkflowDraftMock,
      saveWorkflowDraft: saveWorkflowDraftMock,
    });
  });

  it('returns 400 when version query param is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=0', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "version" must be a positive integer.',
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('saves workflow drafts via the dashboard service', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 3,
      name: 'Demo Tree',
      description: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=3', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo Tree', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: {
        treeKey: 'demo-tree',
        version: 3,
        name: 'Demo Tree',
        description: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
    });
    expect(saveWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    saveWorkflowDraftMock.mockRejectedValue(new Error('save failed'));

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Demo Tree', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'save failed',
        },
      },
    });
  });
});

