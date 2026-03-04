import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';

const { createDashboardServiceMock, archiveRepositoryMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  archiveRepositoryMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/repositories/[name]/actions/archive', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    archiveRepositoryMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      archiveRepository: archiveRepositoryMock,
    });
  });

  it('archives the targeted repository', async () => {
    archiveRepositoryMock.mockResolvedValue({
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
        archivedAt: '2026-03-03T10:20:30.000Z',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/actions/archive', { method: 'POST' }),
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
        archivedAt: '2026-03-03T10:20:30.000Z',
      },
    });
    expect(archiveRepositoryMock).toHaveBeenCalledWith('demo-repo');
  });

  it('maps known integration errors', async () => {
    archiveRepositoryMock.mockRejectedValue(
      new DashboardIntegrationError('auth_required', 'GitHub authentication is required.', {
        status: 401,
      }),
    );

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/actions/archive', { method: 'POST' }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'auth_required',
        message: 'GitHub authentication is required.',
      },
    });
  });
});
