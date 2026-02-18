import { notFound } from 'next/navigation';
import {
  buildRunWorktreeHref,
  findRunByParam,
  resolveWorktreePath,
  type RunRouteRecord,
} from '../run-route-fixtures';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../ui/primitives';

type RunDetailPageProps = Readonly<{
  params: {
    runId: string;
  };
}>;

function renderPrimaryAction(run: RunRouteRecord) {
  if (run.status === 'completed') {
    return (
      <ButtonLink
        href={buildRunWorktreeHref(run.id, resolveWorktreePath(run, undefined) ?? undefined)}
        tone="primary"
      >
        Open Worktree
      </ButtonLink>
    );
  }

  const labelByStatus: Record<Exclude<RunRouteRecord['status'], 'completed'>, string> = {
    pending: 'Pending Start',
    running: 'Pause',
    paused: 'Resume',
    failed: 'Retry Failed Node',
  };

  return (
    <ActionButton tone="primary" disabled aria-disabled="true" title="Implemented in issue #100">
      {labelByStatus[run.status]}
    </ActionButton>
  );
}

export default function RunDetailPage({ params }: RunDetailPageProps) {
  const run = findRunByParam(params.runId);
  if (run === null) {
    notFound();
  }

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
              <span className="meta-text">{run.workflow}</span>
            </li>
            <li>
              <span>Repository</span>
              <span className="meta-text">{run.repository}</span>
            </li>
            <li>
              <span>Started</span>
              <span className="meta-text">{run.startedAtLabel}</span>
            </li>
            <li>
              <span>Completed</span>
              <span className="meta-text">{run.completedAtLabel ?? 'in progress'}</span>
            </li>
          </ul>
        </Card>

        <Panel title="Actions" description="Primary CTA follows run lifecycle status">
          <div className="action-row">
            {renderPrimaryAction(run)}
            <ButtonLink href="/runs">Back to Runs</ButtonLink>
          </div>
        </Panel>
      </div>

      <div className="page-grid">
        <Card title="Timeline" description="Latest run events">
          <ol className="page-stack" aria-label="Run timeline">
            {run.timeline.map((event) => (
              <li key={`${event.timestamp}-${event.summary}`}>
                <p className="meta-text">{event.timestamp}</p>
                <p>{event.summary}</p>
              </li>
            ))}
          </ol>
        </Card>

        <Panel title="Node status" description="Node lifecycle snapshot">
          <ul className="entity-list">
            {run.nodes.map((node) => (
              <li key={node.nodeKey}>
                <span>{node.nodeKey}</span>
                <StatusBadge status={node.status} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Card title="Artifacts and routing decisions">
        <p className="meta-text">Artifacts</p>
        <ul className="page-stack" aria-label="Run artifacts">
          {run.artifacts.map((artifact) => (
            <li key={artifact}>{artifact}</li>
          ))}
        </ul>

        <p className="meta-text">Routing decisions</p>
        <ul className="page-stack" aria-label="Run routing decisions">
          {run.routingDecisions.map((decision) => (
            <li key={decision}>{decision}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

