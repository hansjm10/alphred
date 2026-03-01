import { notFound } from 'next/navigation';
import { createDashboardService } from '../../../../../src/server/dashboard-service';
import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';
import { ButtonLink, Card, Panel } from '../../../../ui/primitives';
import { WorkflowJsonCopyActions } from '../../../workflow-json-copy-client';

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
    const nodes = snapshot.nodes ?? [];
    const edges = snapshot.edges ?? [];
    const nonDefaultRoleNodes = nodes.filter((node) => {
      const nodeRole = node.nodeRole ?? 'standard';
      const maxChildren = node.maxChildren ?? 12;
      return nodeRole !== 'standard' || maxChildren !== 12;
    });
    const failureRouteEdges = edges.filter((edge) => (edge.routeOn ?? 'success') === 'failure');
    const hasFanoutConfiguration = nonDefaultRoleNodes.length > 0 || failureRouteEdges.length > 0;

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

          <Panel title="Fan-out settings">
            {hasFanoutConfiguration ? (
              <ul className="entity-list">
                {nonDefaultRoleNodes.map((node) => (
                  <li key={`node-${node.nodeKey}`}>
                    <span>{node.nodeKey}</span>
                    <span>
                      role {(node.nodeRole ?? 'standard')} · maxChildren {node.maxChildren ?? 12}
                    </span>
                  </li>
                ))}
                {failureRouteEdges.map((edge) => (
                  <li key={`edge-${edge.sourceNodeKey}-${edge.targetNodeKey}-${edge.priority}`}>
                    <span>{edge.sourceNodeKey} → {edge.targetNodeKey}</span>
                    <span>failure route · priority {edge.priority}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta-text">No fan-out specific settings configured.</p>
            )}
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
