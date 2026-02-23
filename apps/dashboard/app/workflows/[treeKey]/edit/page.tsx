import { notFound } from 'next/navigation';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
  DashboardWorkflowDraftTopology,
} from '../../../../src/server/dashboard-contracts';
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
  let resolvedDraft: DashboardWorkflowDraftTopology | null = draft ?? null;
  let bootstrapDraftOnMount = false;
  let providerOptions: DashboardAgentProviderOption[] = [];
  let modelOptions: DashboardAgentModelOption[] = [];

  const service = createDashboardService();
  [providerOptions, modelOptions] = await Promise.all([
    service.listAgentProviders(),
    service.listAgentModels(),
  ]);

  if (!resolvedDraft) {
    try {
      const snapshot = await service.getWorkflowTreeSnapshot(treeKey);
      resolvedDraft = snapshot;
      bootstrapDraftOnMount = snapshot.status !== 'draft';
    } catch (error) {
      if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
        notFound();
      }
      throw error;
    }
  }

  if (!resolvedDraft) {
    notFound();
  }

  return (
    <WorkflowEditorPageContent
      initialDraft={resolvedDraft}
      providerOptions={providerOptions}
      modelOptions={modelOptions}
      bootstrapDraftOnMount={bootstrapDraftOnMount}
    />
  );
}
