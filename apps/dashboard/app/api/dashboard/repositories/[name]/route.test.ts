import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, getRepositoryMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getRepositoryMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET } from './route';

describe('Route /api/dashboard/repositories/[name]', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getRepositoryMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getRepository: getRepositoryMock,
    });
  });

  it('returns the repository snapshot from the dashboard service', async () => {
    getRepositoryMock.mockResolvedValue({
      repository: {
        id: 15,
        name: 'demo',
        provider: 'github',
        remoteRef: 'octocat/demo',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main',
        branchTemplate: null,
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/demo',
        archivedAt: '2026-03-06T00:00:00.000Z',
      },
    });

    const response = await GET(new Request('http://localhost/api/dashboard/repositories/15'), {
      params: Promise.resolve({ name: '15' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: {
        id: 15,
        name: 'demo',
        provider: 'github',
        remoteRef: 'octocat/demo',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main',
        branchTemplate: null,
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/demo',
        archivedAt: '2026-03-06T00:00:00.000Z',
      },
    });
    expect(getRepositoryMock).toHaveBeenCalledWith({
      repositoryId: 15,
      includeArchived: true,
    });
  });

  it('returns 400 for invalid repository ids', async () => {
    const response = await GET(new Request('http://localhost/api/dashboard/repositories/nope'), {
      params: Promise.resolve({ name: 'nope' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'repositoryId must be a positive integer.',
      },
    });
    expect(getRepositoryMock).not.toHaveBeenCalled();
  });

  it('maps service failures to integration error responses', async () => {
    getRepositoryMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Repository id=15 was not found.', {
        status: 404,
      }),
    );

    const response = await GET(new Request('http://localhost/api/dashboard/repositories/15'), {
      params: Promise.resolve({ name: '15' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_found',
        message: 'Repository id=15 was not found.',
      },
    });
  });
});
