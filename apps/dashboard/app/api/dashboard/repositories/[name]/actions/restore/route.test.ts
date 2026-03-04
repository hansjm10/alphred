import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, restoreRepositoryMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  restoreRepositoryMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/repositories/[name]/actions/restore', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    restoreRepositoryMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      restoreRepository: restoreRepositoryMock,
    });
  });

  it('restores the targeted repository', async () => {
    restoreRepositoryMock.mockResolvedValue({
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
        archivedAt: null,
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/actions/restore', { method: 'POST' }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
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
        archivedAt: null,
      },
    });
    expect(restoreRepositoryMock).toHaveBeenCalledWith('demo-repo');
  });

  it('maps known integration errors', async () => {
    restoreRepositoryMock.mockRejectedValue(
      new DashboardIntegrationError('conflict', 'Repository "demo-repo" is not archived.', {
        status: 409,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/actions/restore', { method: 'POST' }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'conflict',
        message: 'Repository "demo-repo" is not archived.',
      },
    });
  });
});
