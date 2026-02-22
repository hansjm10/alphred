import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, publishWorkflowDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  publishWorkflowDraftMock: vi.fn(),
}));

vi.mock('../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/workflows/[treeKey]/draft/publish', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    publishWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      publishWorkflowDraft: publishWorkflowDraftMock,
    });
  });

  it('returns 400 when version query param is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/publish?version=0', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "version" must be a positive integer.',
      },
    });
    expect(publishWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('publishes workflow drafts via the dashboard service', async () => {
    publishWorkflowDraftMock.mockResolvedValue({
      id: 1,
      treeKey: 'demo-tree',
      version: 2,
      name: 'Demo Tree',
      description: null,
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/publish?version=2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionNotes: 'Initial publish' }),
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflow: {
        id: 1,
        treeKey: 'demo-tree',
        version: 2,
        name: 'Demo Tree',
        description: null,
      },
    });
    expect(publishWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });

  it('publishes workflow drafts when the request body is empty', async () => {
    publishWorkflowDraftMock.mockResolvedValue({
      id: 1,
      treeKey: 'demo-tree',
      version: 2,
      name: 'Demo Tree',
      description: null,
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/publish?version=2', {
      method: 'POST',
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    expect(publishWorkflowDraftMock).toHaveBeenCalledWith('demo-tree', 2, {});
  });

  it('returns 400 when publish payload JSON is malformed', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/publish?version=2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"versionNotes":',
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Publish payload must be valid JSON when provided.',
      },
    });
    expect(publishWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when publish payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/publish?version=2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionNotes: 123 }),
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Publish versionNotes must be a string when provided.',
        details: {
          field: 'versionNotes',
        },
      },
    });
    expect(publishWorkflowDraftMock).not.toHaveBeenCalled();
  });
});
