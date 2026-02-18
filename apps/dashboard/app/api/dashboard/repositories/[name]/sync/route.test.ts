import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, syncRepositoryMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  syncRepositoryMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/repositories/[name]/sync', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    syncRepositoryMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      syncRepository: syncRepositoryMock,
    });
  });

  it('syncs the targeted repository', async () => {
    syncRepositoryMock.mockResolvedValue({
      action: 'fetched',
      repository: {
        id: 1,
        name: 'demo-repo',
        provider: 'github',
        remoteRef: 'octocat/demo-repo',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        defaultBranch: 'main',
        branchTemplate: null,
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/demo-repo',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/sync', { method: 'POST' }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: 'fetched',
      repository: {
        id: 1,
        name: 'demo-repo',
        provider: 'github',
        remoteRef: 'octocat/demo-repo',
        remoteUrl: 'https://github.com/octocat/demo-repo.git',
        defaultBranch: 'main',
        branchTemplate: null,
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/demo-repo',
      },
    });
    expect(syncRepositoryMock).toHaveBeenCalledWith('demo-repo');
  });

  it('maps service failures to integration error responses', async () => {
    syncRepositoryMock.mockRejectedValue(new Error('sync failed'));

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/sync', { method: 'POST' }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
      },
    });
  });
});
