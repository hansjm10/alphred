import type { DashboardWorkflowCatalogItem } from '../../src/server/dashboard-contracts';
import { loadDashboardWorkflowCatalog } from './load-dashboard-workflows';
import { WorkflowsPageContent } from './workflows-client';

type WorkflowsPageProps = Readonly<{
  workflows?: readonly DashboardWorkflowCatalogItem[];
}>;

export { WorkflowsPageContent } from './workflows-client';

export default async function WorkflowsPage({ workflows }: WorkflowsPageProps = {}) {
  const resolvedWorkflows = workflows ?? (await loadDashboardWorkflowCatalog());

  return <WorkflowsPageContent workflows={resolvedWorkflows} />;
}

