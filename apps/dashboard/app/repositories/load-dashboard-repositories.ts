import { cache } from 'react';
import type { DashboardRepositoryState } from '../../src/server/dashboard-contracts';
import { createDashboardService } from '../../src/server/dashboard-service';

export const loadDashboardRepositories = cache(async (): Promise<readonly DashboardRepositoryState[]> => {
  const service = createDashboardService();
  return service.listRepositories();
});
