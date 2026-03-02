import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';

const { createDashboardServiceMock, listWorkItemsMock, createWorkItemMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkItemsMock: vi.fn(),
  createWorkItemMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, POST } from './route';

function createContext(repositoryId: string): { params: Promise<{ repositoryId: string }> } {
  return {
    params: Promise.resolve({ repositoryId }),
  };
}

function createJsonRequest(payload: unknown): Request {
  return new Request('http://localhost/api/dashboard/repositories/1/work-items', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

describe('Route /api/dashboard/repositories/[repositoryId]/work-items', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listWorkItemsMock.mockReset();
    createWorkItemMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkItems: listWorkItemsMock,
      createWorkItem: createWorkItemMock,
    });
  });

  describe('GET', () => {
    it('returns work items for the targeted repository id', async () => {
      listWorkItemsMock.mockResolvedValue({
        workItems: [
          {
            id: 11,
            repositoryId: 7,
            title: 'Draft task',
          },
        ],
      });

      const response = await GET(new Request('http://localhost/api/dashboard/repositories/7/work-items'), createContext('7'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workItems: [
          {
            id: 11,
            repositoryId: 7,
            title: 'Draft task',
          },
        ],
      });
      expect(listWorkItemsMock).toHaveBeenCalledWith(7);
    });

    it('returns 400 when repository id path segment is invalid', async () => {
      const response = await GET(
        new Request('http://localhost/api/dashboard/repositories/demo/work-items'),
        createContext('demo'),
      );

      expect(listWorkItemsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'repositoryId must be a positive integer.',
        },
      });
    });

    it('returns 404 when repository is not found', async () => {
      listWorkItemsMock.mockRejectedValue(
        new DashboardIntegrationError('not_found', 'Repository id=7 was not found.', {
          status: 404,
        }),
      );

      const response = await GET(new Request('http://localhost/api/dashboard/repositories/7/work-items'), createContext('7'));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'not_found',
          message: 'Repository id=7 was not found.',
        },
      });
    });
  });

  describe('POST', () => {
    it('creates a work item for the targeted repository id', async () => {
      createWorkItemMock.mockResolvedValue({
        workItem: {
          id: 19,
          repositoryId: 3,
          type: 'task',
          status: 'Draft',
          title: 'Implement API route',
        },
      });

      const response = await POST(
        createJsonRequest({
          type: 'task',
          title: 'Implement API route',
          actorType: 'human',
          actorLabel: 'alice',
          tags: ['api'],
        }),
        createContext('3'),
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        workItem: {
          id: 19,
          repositoryId: 3,
          type: 'task',
          status: 'Draft',
          title: 'Implement API route',
        },
      });
      expect(createWorkItemMock).toHaveBeenCalledWith({
        repositoryId: 3,
        type: 'task',
        title: 'Implement API route',
        actorType: 'human',
        actorLabel: 'alice',
        tags: ['api'],
      });
    });

    it('returns 400 when create payload is invalid', async () => {
      const response = await POST(
        createJsonRequest({
          title: 'Missing type',
          actorType: 'human',
          actorLabel: 'alice',
        }),
        createContext('3'),
      );

      expect(createWorkItemMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Field "type" must be one of: epic, feature, story, task.',
        },
      });
    });

    it('returns 400 for malformed json payloads', async () => {
      const response = await POST(
        new Request('http://localhost/api/dashboard/repositories/3/work-items', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: '{"type":',
        }),
        createContext('3'),
      );

      expect(createWorkItemMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Work item create payload must be valid JSON.',
        },
      });
    });

    it('returns 409 when the service reports a conflict', async () => {
      createWorkItemMock.mockRejectedValue(
        new DashboardIntegrationError('conflict', 'Work item title already exists.', {
          status: 409,
        }),
      );

      const response = await POST(
        createJsonRequest({
          type: 'task',
          title: 'Implement API route',
          actorType: 'human',
          actorLabel: 'alice',
        }),
        createContext('3'),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'conflict',
          message: 'Work item title already exists.',
        },
      });
    });
  });
});
