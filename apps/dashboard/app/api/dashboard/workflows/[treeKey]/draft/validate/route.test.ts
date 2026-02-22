import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, validateWorkflowDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  validateWorkflowDraftMock: vi.fn(),
}));

vi.mock('../../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/workflows/[treeKey]/draft/validate', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    validateWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      validateWorkflowDraft: validateWorkflowDraftMock,
    });
  });

  it('returns 400 when version query param is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/validate?version=0', {
      method: 'POST',
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "version" must be a positive integer.',
      },
    });
    expect(validateWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns validation results from the dashboard service', async () => {
    validateWorkflowDraftMock.mockResolvedValue({
      errors: [],
      warnings: [],
      initialRunnableNodeKeys: ['design'],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft/validate?version=2', {
      method: 'POST',
    });

    const response = await POST(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: {
        errors: [],
        warnings: [],
        initialRunnableNodeKeys: ['design'],
      },
    });
    expect(validateWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });
});

