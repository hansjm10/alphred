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
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
        branch: 'main',
        status: 'updated',
        conflictMessage: null,
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
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
        branch: 'main',
        status: 'updated',
        conflictMessage: null,
      },
    });
    expect(syncRepositoryMock).toHaveBeenCalledWith('demo-repo', {});
  });

  it('accepts a strategy payload and forwards it to the service', async () => {
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
      sync: {
        mode: 'pull',
        strategy: 'rebase',
        branch: 'main',
        status: 'up_to_date',
        conflictMessage: null,
      },
    });

    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          strategy: 'rebase',
        }),
      }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(200);
    expect(syncRepositoryMock).toHaveBeenCalledWith('demo-repo', { strategy: 'rebase' });
  });

  it('returns invalid_request for unknown strategy values', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          strategy: 'squash',
        }),
      }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Field "strategy" must be one of: ff-only, merge, rebase.',
      },
    });
    expect(syncRepositoryMock).not.toHaveBeenCalled();
  });

  it('returns invalid_request for malformed json payloads', async () => {
    const response = await POST(
      new Request('http://localhost/api/dashboard/repositories/demo-repo/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: '{"strategy":',
      }),
      {
        params: Promise.resolve({ name: 'demo-repo' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Repository sync payload must be valid JSON.',
      },
    });
    expect(syncRepositoryMock).not.toHaveBeenCalled();
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
        details: {
          cause: 'sync failed',
        },
      },
    });
  });
});
