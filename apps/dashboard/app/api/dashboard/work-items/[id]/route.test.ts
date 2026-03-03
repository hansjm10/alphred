import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, getWorkItemMock, updateWorkItemFieldsMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  updateWorkItemFieldsMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, PATCH } from './route';

function createContext(id: string): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({ id }),
  };
}

describe('Route /api/dashboard/work-items/[id]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getWorkItemMock.mockReset();
    updateWorkItemFieldsMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getWorkItem: getWorkItemMock,
      updateWorkItemFields: updateWorkItemFieldsMock,
    });
  });

  describe('GET', () => {
    it('returns a work item when repositoryId and id are valid', async () => {
      getWorkItemMock.mockResolvedValue({
        workItem: {
          id: 12,
          repositoryId: 4,
          title: 'Add tests',
        },
      });

      const response = await GET(
        new Request('http://localhost/api/dashboard/work-items/12?repositoryId=4'),
        createContext('12'),
      );

      expect(getWorkItemMock).toHaveBeenCalledWith({ repositoryId: 4, workItemId: 12 });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workItem: {
          id: 12,
          repositoryId: 4,
          title: 'Add tests',
        },
      });
    });

    it('returns 400 when repositoryId query param is missing or invalid', async () => {
      const response = await GET(new Request('http://localhost/api/dashboard/work-items/12'), createContext('12'));

      expect(getWorkItemMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Query parameter "repositoryId" must be a positive integer.',
        },
      });
    });

    it('returns 400 when work item id path segment is invalid', async () => {
      const response = await GET(
        new Request('http://localhost/api/dashboard/work-items/not-a-number?repositoryId=4'),
        createContext('not-a-number'),
      );

      expect(getWorkItemMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'workItemId must be a positive integer.',
        },
      });
    });

    it('returns 404 when the work item is not found', async () => {
      getWorkItemMock.mockRejectedValue(
        new DashboardIntegrationError('not_found', 'Work item id=12 was not found.', {
          status: 404,
        }),
      );

      const response = await GET(
        new Request('http://localhost/api/dashboard/work-items/12?repositoryId=4'),
        createContext('12'),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'not_found',
          message: 'Work item id=12 was not found.',
        },
      });
    });
  });

  describe('PATCH', () => {
    it('updates work item fields', async () => {
      updateWorkItemFieldsMock.mockResolvedValue({
        workItem: {
          id: 12,
          repositoryId: 4,
          title: 'Updated title',
          revision: 3,
        },
      });

      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: 4,
            expectedRevision: 2,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(updateWorkItemFieldsMock).toHaveBeenCalledWith({
        repositoryId: 4,
        workItemId: 12,
        expectedRevision: 2,
        title: 'Updated title',
        actorType: 'human',
        actorLabel: 'alice',
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workItem: {
          id: 12,
          repositoryId: 4,
          title: 'Updated title',
          revision: 3,
        },
      });
    });

    it('returns 400 when expectedRevision is missing', async () => {
      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: 4,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(updateWorkItemFieldsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Field "expectedRevision" must be a non-negative integer.',
        },
      });
    });

    it('returns 400 when expectedRevision is null', async () => {
      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: 4,
            expectedRevision: null,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(updateWorkItemFieldsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Field "expectedRevision" must be a non-negative integer.',
        },
      });
    });

    it('returns 400 when repositoryId is not a number', async () => {
      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: true,
            expectedRevision: 2,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(updateWorkItemFieldsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Field "repositoryId" must be a positive integer.',
        },
      });
    });

    it('returns 400 for malformed json payloads', async () => {
      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: '{"repositoryId":',
        }),
        createContext('12'),
      );

      expect(updateWorkItemFieldsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Work item update payload must be valid JSON.',
        },
      });
    });

    it('returns 409 when the service reports a conflict', async () => {
      updateWorkItemFieldsMock.mockRejectedValue(
        new DashboardIntegrationError('conflict', 'Work item id=12 revision conflict.', {
          status: 409,
        }),
      );

      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: 4,
            expectedRevision: 2,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'conflict',
          message: 'Work item id=12 revision conflict.',
        },
      });
    });

    it('maps unhandled failures to 500 responses', async () => {
      updateWorkItemFieldsMock.mockRejectedValue(new Error('update failed'));

      const response = await PATCH(
        new Request('http://localhost/api/dashboard/work-items/12', {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repositoryId: 4,
            expectedRevision: 2,
            title: 'Updated title',
            actorType: 'human',
            actorLabel: 'alice',
          }),
        }),
        createContext('12'),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'Dashboard integration request failed.',
          details: {
            cause: 'update failed',
          },
        },
      });
    });
  });
});
