import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DashboardRunDetail,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';

const {
  createDashboardServiceMock,
  listWorkflowRunsMock,
  listWorkflowTreesMock,
  getWorkflowRunDetailMock,
} = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkflowRunsMock: vi.fn(),
  listWorkflowTreesMock: vi.fn(),
  getWorkflowRunDetailMock: vi.fn(),
}));

vi.mock('../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import {
  loadDashboardRunDetail,
  loadDashboardRunSummaries,
  loadDashboardWorkflowTrees,
} from './load-dashboard-runs';

describe('load-dashboard-runs', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listWorkflowRunsMock.mockReset();
    listWorkflowTreesMock.mockReset();
    getWorkflowRunDetailMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkflowRuns: listWorkflowRunsMock,
      listWorkflowTrees: listWorkflowTreesMock,
      getWorkflowRunDetail: getWorkflowRunDetailMock,
    });
  });

  it('loads run summaries with the default limit', async () => {
    const runs: readonly DashboardRunSummary[] = [];
    listWorkflowRunsMock.mockResolvedValue(runs);

    const first = await loadDashboardRunSummaries();
    const second = await loadDashboardRunSummaries();

    expect(first).toBe(runs);
    expect(second).toBe(runs);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(2);
    expect(listWorkflowRunsMock).toHaveBeenCalledTimes(2);
    expect(listWorkflowRunsMock).toHaveBeenNthCalledWith(1, 50);
    expect(listWorkflowRunsMock).toHaveBeenNthCalledWith(2, 50);
  });

  it('loads workflow trees', async () => {
    const trees: readonly DashboardWorkflowTreeSummary[] = [];
    listWorkflowTreesMock.mockResolvedValue(trees);

    const first = await loadDashboardWorkflowTrees();
    const second = await loadDashboardWorkflowTrees();

    expect(first).toBe(trees);
    expect(second).toBe(trees);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(2);
    expect(listWorkflowTreesMock).toHaveBeenCalledTimes(2);
  });

  it('loads run detail per run id', async () => {
    const detail42 = { run: { id: 42 } } as DashboardRunDetail;
    const detail43 = { run: { id: 43 } } as DashboardRunDetail;
    getWorkflowRunDetailMock.mockImplementation(async (runId: number) =>
      runId === 42 ? detail42 : detail43,
    );

    const first42 = await loadDashboardRunDetail(42);
    const second42 = await loadDashboardRunDetail(42);
    const first43 = await loadDashboardRunDetail(43);

    expect(first42).toBe(detail42);
    expect(second42).toBe(detail42);
    expect(first43).toBe(detail43);
    expect(createDashboardServiceMock).toHaveBeenCalledTimes(3);
    expect(getWorkflowRunDetailMock).toHaveBeenCalledTimes(3);
    expect(getWorkflowRunDetailMock).toHaveBeenNthCalledWith(1, 42);
    expect(getWorkflowRunDetailMock).toHaveBeenNthCalledWith(2, 42);
    expect(getWorkflowRunDetailMock).toHaveBeenNthCalledWith(3, 43);
  });
});
