import { cache } from 'react';
import type { DashboardRepositoryState } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';

export const loadDashboardRepositories = cache(
  async (includeArchived = true): Promise<readonly DashboardRepositoryState[]> => {
    const service = createDashboardService();
    return service.listRepositories({ includeArchived });
  },
);
