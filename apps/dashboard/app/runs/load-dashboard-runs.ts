import { cache } from 'react';
import type {
  DashboardRunDetail,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';
import { createDashboardService } from '../../src/server/dashboard-service';

const DEFAULT_RUN_LIST_LIMIT = 50;

export const loadDashboardRunSummaries = cache(async (): Promise<readonly DashboardRunSummary[]> => {
  const service = createDashboardService();
  return service.listWorkflowRuns(DEFAULT_RUN_LIST_LIMIT);
});

export const loadDashboardWorkflowTrees = cache(async (): Promise<readonly DashboardWorkflowTreeSummary[]> => {
  const service = createDashboardService();
  return service.listWorkflowTrees();
});

export const loadDashboardRunDetail = cache(async (runId: number): Promise<DashboardRunDetail> => {
  const service = createDashboardService();
  return service.getWorkflowRunDetail(runId);
});
