import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, generateStoryBreakdownDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  generateStoryBreakdownDraftMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

function createContext(id: string): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe('POST /api/dashboard/work-items/[id]/actions/generate-breakdown', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    generateStoryBreakdownDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      generateStoryBreakdownDraft: generateStoryBreakdownDraftMock,
    });
  });

  it('generates a codex-backed story breakdown draft', async () => {
    generateStoryBreakdownDraftMock.mockResolvedValue({
      story: {
        id: 14,
        status: 'BreakdownProposed',
      },
      tasks: [
        {
          id: 15,
          status: 'Draft',
        },
      ],
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/generate-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
        }),
      }),
      createContext('14'),
    );

    expect(generateStoryBreakdownDraftMock).toHaveBeenCalledWith({
      repositoryId: 5,
      storyId: 14,
      expectedRevision: 2,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      story: {
        id: 14,
        status: 'BreakdownProposed',
      },
      tasks: [
        {
          id: 15,
          status: 'Draft',
        },
      ],
    });
  });

  it('returns 400 when expectedRevision is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/generate-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
        }),
      }),
      createContext('14'),
    );

    expect(generateStoryBreakdownDraftMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "expectedRevision" must be a non-negative integer.',
      },
    });
  });

  it('returns 400 when work item id path segment is invalid', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/oops/actions/generate-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
        }),
      }),
      createContext('oops'),
    );

    expect(generateStoryBreakdownDraftMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'workItemId must be a positive integer.',
      },
    });
  });

  it('returns 409 when the service reports a conflict', async () => {
    generateStoryBreakdownDraftMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Codex returned an invalid breakdown payload.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/generate-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repositoryId: 5,
          expectedRevision: 2,
        }),
      }),
      createContext('14'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Codex returned an invalid breakdown payload.',
      },
    });
  });

  it('returns 400 for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/work-items/14/actions/generate-breakdown', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"repositoryId":',
      }),
      createContext('14'),
    );

    expect(generateStoryBreakdownDraftMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Work item breakdown generation payload must be valid JSON.',
      },
    });
  });
});
