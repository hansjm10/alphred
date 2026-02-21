import { notFound } from 'next/navigation';
import { createDashboardService } from '../../../src/server/dashboard-service';
import { DashboardIntegrationError } from '../../../src/server/dashboard-errors';
import { ButtonLink, Card, Panel } from '../../ui/primitives';
import { WorkflowJsonCopyActions } from '../workflow-json-copy-client';

type WorkflowDetailPageProps = Readonly<{
  params: Promise<{
    treeKey: string;
  }>;
}>;

export default async function WorkflowDetailPage({ params }: WorkflowDetailPageProps) {
  const { treeKey } = await params;
  const service = createDashboardService();

  try {
    const snapshot = await service.getWorkflowTreeSnapshot(treeKey);
    const json = JSON.stringify(snapshot, null, 2);

    return (
      <div className="page-stack">
        <Card
          title={snapshot.name}
          description={`${snapshot.status === 'draft' ? 'Draft' : 'Published'} v${snapshot.version}`}
        >
          <div className="workflows-toolbar">
            <div className="workflow-actions">
              <ButtonLink href={`/workflows/${encodeURIComponent(snapshot.treeKey)}/edit`}>Edit</ButtonLink>
              <ButtonLink href="/workflows">Back</ButtonLink>
            </div>
          </div>

          <Panel title="Summary">
            <ul className="entity-list">
              <li>
                <span>Tree key</span>
                <code className="repo-path">{snapshot.treeKey}</code>
              </li>
              <li>
                <span>Initial runnable nodes</span>
                <span>{snapshot.initialRunnableNodeKeys.length > 0 ? snapshot.initialRunnableNodeKeys.join(', ') : '—'}</span>
              </li>
            </ul>
          </Panel>

          <Panel title="View JSON">
            <div className="workflows-toolbar">
              <WorkflowJsonCopyActions json={json} />
            </div>
            <pre className="workflow-json" aria-label="Workflow JSON">{json}</pre>
          </Panel>
        </Card>
      </div>
    );
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
      notFound();
    }
    throw error;
  }
}
