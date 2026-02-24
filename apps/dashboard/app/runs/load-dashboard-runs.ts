import { cache } from 'react';
import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';
import { createDashboardService } from '../../src/server/dashboard-service';

const DEFAULT_RUN_LIMIT = 20;

export const loadDashboardRuns = cache(async (limit = DEFAULT_RUN_LIMIT): Promise<readonly DashboardRunSummary[]> => {
  const service = createDashboardService();
  return service.listWorkflowRuns(limit);
});
