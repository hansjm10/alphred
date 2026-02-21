import { notFound } from 'next/navigation';
import type { DashboardWorkflowDraftTopology } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../src/server/dashboard-service';
import { WorkflowEditorPageContent } from './workflow-editor-client';

type WorkflowEditorPageProps = Readonly<{
  draft?: DashboardWorkflowDraftTopology;
  params: Promise<{
    treeKey: string;
  }>;
}>;

export { WorkflowEditorPageContent } from './workflow-editor-client';

export default async function WorkflowEditorPage({ draft, params }: WorkflowEditorPageProps) {
  const { treeKey } = await params;
  const service = createDashboardService();

  let resolvedDraft: DashboardWorkflowDraftTopology;
  try {
    resolvedDraft = draft ?? (await service.getOrCreateWorkflowDraft(treeKey));
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
      notFound();
    }
    throw error;
  }

  return <WorkflowEditorPageContent initialDraft={resolvedDraft} />;
}

