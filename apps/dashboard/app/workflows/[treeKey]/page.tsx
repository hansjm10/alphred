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
