import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, listRepositoriesMock, createRepositoryMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listRepositoriesMock: vi.fn(),
  createRepositoryMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, POST } from './route';

function createJsonRequest(payload: unknown): Request {
  return new Request('http://localhost/api/dashboard/repositories', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

describe('Route /api/dashboard/repositories', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listRepositoriesMock.mockReset();
    createRepositoryMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listRepositories: listRepositoriesMock,
      createRepository: createRepositoryMock,
    });
  });

  describe('GET', () => {
    it('returns repositories from the dashboard service', async () => {
      listRepositoriesMock.mockResolvedValue([
        {
          id: 1,
          name: 'demo',
          archivedAt: null,
        },
      ]);

      const response = await GET(new Request('http://localhost/api/dashboard/repositories'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        repositories: [
          {
            id: 1,
            name: 'demo',
            archivedAt: null,
          },
        ],
      });
      expect(listRepositoriesMock).toHaveBeenCalledTimes(1);
      expect(listRepositoriesMock).toHaveBeenCalledWith({ includeArchived: false });
    });

    it('forwards includeArchived=1 to list options', async () => {
      listRepositoriesMock.mockResolvedValue([]);

      const response = await GET(new Request('http://localhost/api/dashboard/repositories?includeArchived=1'));

      expect(response.status).toBe(200);
      expect(listRepositoriesMock).toHaveBeenCalledWith({ includeArchived: true });
    });

    it('returns 400 for invalid includeArchived query values', async () => {
      const response = await GET(new Request('http://localhost/api/dashboard/repositories?includeArchived=maybe'));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Query parameter "includeArchived" must be one of: 1, 0, true, false.',
        },
      });
      expect(listRepositoriesMock).not.toHaveBeenCalled();
    });

    it('maps service failures to integration error responses', async () => {
      listRepositoriesMock.mockRejectedValue(new Error('cannot connect'));

      const response = await GET(new Request('http://localhost/api/dashboard/repositories'));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'Dashboard integration request failed.',
          details: {
            cause: 'cannot connect',
          },
        },
      });
    });
  });

  describe('POST', () => {
    it('creates a repository through the dashboard service', async () => {
      createRepositoryMock.mockResolvedValue({
        repository: {
          id: 2,
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
          remoteUrl: 'https://github.com/octocat/new-repo.git',
          defaultBranch: 'main',
          branchTemplate: null,
          cloneStatus: 'pending',
          localPath: null,
          archivedAt: null,
        },
      });

      const response = await POST(
        createJsonRequest({
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
        }),
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        repository: {
          id: 2,
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
          remoteUrl: 'https://github.com/octocat/new-repo.git',
          defaultBranch: 'main',
          branchTemplate: null,
          cloneStatus: 'pending',
          localPath: null,
          archivedAt: null,
        },
      });
      expect(createRepositoryMock).toHaveBeenCalledWith({
        name: 'new-repo',
        provider: 'github',
        remoteRef: 'octocat/new-repo',
      });
    });

    it.each([
      {
        title: 'body is not an object',
        payload: null,
        message: 'Repository create request body must be an object.',
      },
      {
        title: 'name is missing',
        payload: {
          provider: 'github',
          remoteRef: 'octocat/new-repo',
        },
        message: 'Repository create requires string field "name".',
      },
      {
        title: 'provider is unsupported',
        payload: {
          name: 'new-repo',
          provider: 'azure-devops',
          remoteRef: 'octocat/new-repo',
        },
        message: 'Field "provider" must be "github".',
      },
      {
        title: 'remoteRef is missing',
        payload: {
          name: 'new-repo',
          provider: 'github',
        },
        message: 'Repository create requires string field "remoteRef".',
      },
    ])('returns 400 when $title', async ({ payload, message }) => {
      const response = await POST(createJsonRequest(payload));

      expect(createRepositoryMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message,
        },
      });
    });

    it('returns 409 when repository already exists', async () => {
      createRepositoryMock.mockRejectedValue(
        new DashboardIntegrationError('conflict', 'Repository "new-repo" already exists.', {
          status: 409,
        }),
      );

      const response = await POST(
        createJsonRequest({
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'conflict',
          message: 'Repository "new-repo" already exists.',
        },
      });
    });

    it('maps unhandled service failures to 500 responses', async () => {
      createRepositoryMock.mockRejectedValue(new Error('cannot create'));

      const response = await POST(
        createJsonRequest({
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'Dashboard integration request failed.',
          details: {
            cause: 'cannot create',
          },
        },
      });
    });
  });
});
