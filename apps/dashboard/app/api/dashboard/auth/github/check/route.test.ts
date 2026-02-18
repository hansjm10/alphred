import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    checkGitHubAuthMock.mockResolvedValue({
      authenticated: true,
      message: 'ok',
    });

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      message: 'ok',
    });
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
      },
    });
  });
});
