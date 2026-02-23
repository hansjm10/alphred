import { cache } from 'react';
import type { DashboardWorkflowCatalogItem } from '../../src/server/dashboard-contracts';
import { createDashboardService } from '../../src/server/dashboard-service';

export const loadDashboardWorkflowCatalog = cache(async (): Promise<readonly DashboardWorkflowCatalogItem[]> => {
  const service = createDashboardService();
  return service.listWorkflowCatalog();
});

