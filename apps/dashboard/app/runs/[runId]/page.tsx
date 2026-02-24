import { buildRunWorktreeHref } from '../run-route-utils';
import {
  resolveRunWorktreePath,
  toRunDetailViewModel,
  type RunDetailViewModel,
} from '../run-view-models';
import { loadDashboardRunDetail } from './load-dashboard-run-detail';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../ui/primitives';

type RunDetailPageProps = Readonly<{
  params: Promise<{
    runId: string;
  }>;
}>;

function renderPrimaryAction(run: RunDetailViewModel) {
  if (run.status === 'completed') {
    const defaultWorktreePath = resolveRunWorktreePath(run.worktrees, undefined) ?? undefined;

    return (
      <ButtonLink
        href={buildRunWorktreeHref(run.id, defaultWorktreePath)}
        tone="primary"
      >
        Open Worktree
      </ButtonLink>
    );
  }

  const labelByStatus: Record<Exclude<RunDetailViewModel['status'], 'completed'>, string> = {
    pending: 'Pending Start',
    running: 'Pause',
    paused: 'Resume',
    failed: 'Retry Failed Node',
    cancelled: 'Run Cancelled',
  };

  return (
    <ActionButton tone="primary" disabled aria-disabled="true" title="Implemented in issue #100">
      {labelByStatus[run.status]}
    </ActionButton>
  );
}

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { runId } = await params;
  const detail = await loadDashboardRunDetail(runId);
  const run = toRunDetailViewModel(detail);

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${run.id}`}</h2>
        <p>Timeline, node lifecycle, and run-scoped investigation links.</p>
      </section>

      <div className="page-grid">
        <Card title="Run summary" description="Current status and context">
          <ul className="entity-list">
            <li>
              <span>Status</span>
              <StatusBadge status={run.status} />
            </li>
            <li>
              <span>Workflow</span>
              <span className="meta-text">{run.workflowLabel}</span>
            </li>
            <li>
              <span>Tree</span>
              <span className="meta-text">{run.workflowMetaLabel}</span>
            </li>
            <li>
              <span>Started</span>
              <span className="meta-text">{run.startedAtLabel}</span>
            </li>
            <li>
              <span>Completed</span>
              <span className="meta-text">{run.completedAtLabel}</span>
            </li>
            <li>
              <span>Created</span>
              <span className="meta-text">{run.createdAtLabel}</span>
            </li>
          </ul>
        </Card>

        <Panel title="Actions" description="Primary CTA follows run lifecycle status">
          <div className="action-row">
            {renderPrimaryAction(run)}
            <ButtonLink href="/runs">Back to Runs</ButtonLink>
          </div>
          <p className="meta-text">{`Node summary: ${run.nodeSummaryLabel}`}</p>
          <p className="meta-text">{`Worktrees tracked: ${run.worktrees.length}`}</p>
        </Panel>
      </div>

      <div className="page-grid">
        <Panel title="Node status" description="Node lifecycle snapshot from backend data">
          {run.nodes.length === 0 ? (
            <p>No node snapshots are available for this run yet.</p>
          ) : (
            <ul className="entity-list">
              {run.nodes.map((node) => (
                <li key={node.id}>
                  <div>
                    <span>{node.nodeKey}</span>
                    <p className="meta-text">{`${node.attemptLabel} · Started ${node.startedAtLabel}`}</p>
                    {node.latestArtifactLabel ? (
                      <p className="meta-text">{`Latest artifact: ${node.latestArtifactLabel}`}</p>
                    ) : null}
                    {node.latestRoutingDecisionLabel ? (
                      <p className="meta-text">{`Latest routing: ${node.latestRoutingDecisionLabel}`}</p>
                    ) : null}
                  </div>
                  <StatusBadge status={node.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Card title="Artifacts" description="Recent artifact snapshots">
          {run.artifacts.length === 0 ? (
            <p>No artifacts recorded for this run.</p>
          ) : (
            <ul className="page-stack" aria-label="Run artifacts">
              {run.artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <p>{artifact.artifactLabel}</p>
                  <p className="meta-text">{`${artifact.runNodeLabel} · ${artifact.createdAtLabel}`}</p>
                  <p>{artifact.preview}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Routing decisions" description="Recent routing outcomes">
        {run.routingDecisions.length === 0 ? (
          <p>No routing decisions recorded for this run.</p>
        ) : (
          <ul className="page-stack" aria-label="Run routing decisions">
            {run.routingDecisions.map((decision) => (
              <li key={decision.id}>
                <p>{decision.decisionLabel}</p>
                <p className="meta-text">{`${decision.runNodeLabel} · ${decision.createdAtLabel}`}</p>
                <p>{decision.rationaleLabel}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
