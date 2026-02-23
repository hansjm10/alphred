import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardGitHubAuthStatus } from '../../../../../../src/server/dashboard-contracts';

const { createDashboardServiceMock, checkGitHubAuthMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  checkGitHubAuthMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { POST } from './route';

describe('POST /api/dashboard/auth/github/check', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    checkGitHubAuthMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      checkGitHubAuth: checkGitHubAuthMock,
    });
  });

  it('returns GitHub auth status from the dashboard service', async () => {
    const authStatus = {
      authenticated: true,
      user: 'octocat',
      scopes: ['repo', 'workflow'],
      error: null,
    } satisfies DashboardGitHubAuthStatus;
    checkGitHubAuthMock.mockResolvedValue(authStatus);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual(authStatus);
    expect(checkGitHubAuthMock).toHaveBeenCalledTimes(1);
  });

  it('returns unauthenticated payload shape from the dashboard service without remapping', async () => {
    const authStatus = {
      authenticated: false,
      user: null,
      scopes: [],
      error: 'Run gh auth login before syncing repositories.',
    } satisfies DashboardGitHubAuthStatus;
    checkGitHubAuthMock.mockResolvedValue(authStatus);

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(authStatus);
    expect(checkGitHubAuthMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    checkGitHubAuthMock.mockRejectedValue(new Error('kaboom'));

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'kaboom',
        },
      },
    });
  });
});
