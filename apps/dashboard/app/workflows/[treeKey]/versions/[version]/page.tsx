import { notFound } from 'next/navigation';
import { createDashboardService } from '../../../../../src/server/dashboard-service';
import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';
import { ButtonLink, Card, Panel } from '../../../../ui/primitives';

type WorkflowVersionPageProps = Readonly<{
  params: Promise<{
    treeKey: string;
    version: string;
  }>;
}>;

function parseVersion(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export default async function WorkflowVersionPage({ params }: WorkflowVersionPageProps) {
  const { treeKey, version } = await params;
  const parsedVersion = parseVersion(version);
  if (parsedVersion === null) {
    notFound();
  }

  const service = createDashboardService();

  try {
    const snapshot = await service.getWorkflowTreeVersionSnapshot(treeKey, parsedVersion);
    const json = JSON.stringify(snapshot, null, 2);

    return (
      <div className="page-stack">
        <Card
          title={`${snapshot.name} v${snapshot.version}`}
          description={snapshot.status === 'draft' ? 'Draft version snapshot' : 'Published version snapshot'}
        >
          <div className="workflows-toolbar">
            <div className="workflow-actions">
              <ButtonLink href={`/workflows/${encodeURIComponent(snapshot.treeKey)}`}>Back</ButtonLink>
              <ButtonLink href={`/workflows/${encodeURIComponent(snapshot.treeKey)}/edit`}>Edit</ButtonLink>
            </div>
          </div>

          <Panel title="View JSON">
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
