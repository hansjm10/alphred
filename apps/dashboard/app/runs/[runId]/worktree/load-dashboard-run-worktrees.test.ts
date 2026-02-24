import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';

const { createDashboardServiceMock, getWorkflowRunDetailMock, NOT_FOUND_ERROR, notFoundMock } = vi.hoisted(() => {
  const error = new Error('NEXT_NOT_FOUND');

  return {
    createDashboardServiceMock: vi.fn(),
    getWorkflowRunDetailMock: vi.fn(),
    NOT_FOUND_ERROR: error,
    notFoundMock: vi.fn(() => {
      throw error;
    }),
  };
});

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

import { loadDashboardRunWorktrees } from './load-dashboard-run-worktrees';

describe('loadDashboardRunWorktrees', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getWorkflowRunDetailMock.mockReset();
    notFoundMock.mockClear();
    createDashboardServiceMock.mockReturnValue({
      getWorkflowRunDetail: getWorkflowRunDetailMock,
    });
  });

  it('loads run worktree metadata for valid run id params', async () => {
    getWorkflowRunDetailMock.mockResolvedValue({
      run: { id: 51 },
      worktrees: [{ id: 1, path: '/tmp/worktree' }],
    });

    await expect(loadDashboardRunWorktrees('51')).resolves.toEqual({
      run: { id: 51 },
      worktrees: [{ id: 1, path: '/tmp/worktree' }],
    });
    expect(getWorkflowRunDetailMock).toHaveBeenCalledWith(51);
  });

  it('routes invalid run id params to not-found', async () => {
    await expect(loadDashboardRunWorktrees('0')).rejects.toThrow(NOT_FOUND_ERROR);
    expect(getWorkflowRunDetailMock).not.toHaveBeenCalled();
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('routes not_found integration errors to not-found', async () => {
    getWorkflowRunDetailMock.mockRejectedValue(
      new DashboardIntegrationError('not_found', 'Workflow run id=504 was not found.', { status: 404 }),
    );

    await expect(loadDashboardRunWorktrees('504')).rejects.toThrow(NOT_FOUND_ERROR);
    expect(notFoundMock).toHaveBeenCalled();
  });

  it('rethrows non-not-found errors', async () => {
    const expectedError = new DashboardIntegrationError('internal_error', 'unexpected failure', { status: 500 });
    getWorkflowRunDetailMock.mockRejectedValue(expectedError);

    await expect(loadDashboardRunWorktrees('505')).rejects.toThrow(expectedError);
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
