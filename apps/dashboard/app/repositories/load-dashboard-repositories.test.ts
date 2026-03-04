import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardRepositoryState } from '@dashboard/server/dashboard-contracts';

const { createDashboardServiceMock, listRepositoriesMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listRepositoriesMock: vi.fn(),
}));

vi.mock('@dashboard/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

describe('loadDashboardRepositories', () => {
  beforeEach(() => {
    vi.resetModules();
    createDashboardServiceMock.mockReset();
    listRepositoriesMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listRepositories: listRepositoriesMock,
    });
  });

  it('defaults to active repositories only', async () => {
    const repositories: readonly DashboardRepositoryState[] = [];
    listRepositoriesMock.mockResolvedValue(repositories);

    const { loadDashboardRepositories } = await import('./load-dashboard-repositories');

    await expect(loadDashboardRepositories()).resolves.toBe(repositories);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(1);
    expect(listRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(listRepositoriesMock).toHaveBeenCalledWith({ includeArchived: false });
  });

  it('includes archived repositories when explicitly requested', async () => {
    const repositories: readonly DashboardRepositoryState[] = [];
    listRepositoriesMock.mockResolvedValue(repositories);

    const { loadDashboardRepositories } = await import('./load-dashboard-repositories');

    await expect(loadDashboardRepositories(true)).resolves.toBe(repositories);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(1);
    expect(listRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(listRepositoriesMock).toHaveBeenCalledWith({ includeArchived: true });
  });
});
