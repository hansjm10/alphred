import { cache } from 'react';
import type { DashboardWorkflowCatalogItem } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';

export const loadDashboardWorkflowCatalog = cache(async (): Promise<readonly DashboardWorkflowCatalogItem[]> => {
  const service = createDashboardService();
  return service.listWorkflowCatalog();
});

