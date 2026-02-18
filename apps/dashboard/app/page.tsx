import Link from 'next/link';
import {
  RUN_ROUTE_FIXTURES,
  buildRunDetailHref,
  type RunRouteRecord,
} from './runs/run-route-fixtures';
import { ButtonLink, Card, Panel, StatusBadge } from './ui/primitives';

type PageProps = Readonly<{
  activeRuns?: readonly RunRouteRecord[];
}>;

function listDefaultActiveRuns(): readonly RunRouteRecord[] {
  return RUN_ROUTE_FIXTURES.filter((run) => run.status === 'running' || run.status === 'paused');
}

export default function Page({ activeRuns }: PageProps = {}) {
  const visibleActiveRuns = activeRuns ?? listDefaultActiveRuns();

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>System readiness</h2>
        <p>Verify auth, sync repositories, and launch runs from a consistent operator shell.</p>
      </section>

      <div className="page-grid">
        <Card title="Global readiness" description="Current operator prerequisites">
          <ul className="entity-list">
            <li>
              <span>GitHub Auth</span>
              <StatusBadge status="completed" label="Authenticated" />
            </li>
            <li>
              <span>Repository Sync Queue</span>
              <StatusBadge status="pending" label="1 pending" />
            </li>
            <li>
              <span>Workflow Engine</span>
              <StatusBadge status="running" label="Healthy" />
            </li>
          </ul>

          <p className="meta-text">Active runs</p>
          {visibleActiveRuns.length === 0 ? (
            <div className="page-stack">
              <h3>No active runs</h3>
              <p>Connect GitHub, sync a repository, and launch your first run.</p>
              <div className="action-row">
                <ButtonLink href="/settings/integrations">Connect GitHub</ButtonLink>
                <ButtonLink href="/repositories">Go to Repositories</ButtonLink>
              </div>
            </div>
          ) : (
            <ul className="entity-list">
              {visibleActiveRuns.map((run) => (
                <li key={run.id}>
                  <Link href={buildRunDetailHref(run.id)}>{`Run #${run.id} ${run.workflow}`}</Link>
                  <StatusBadge status={run.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Panel title="Actions" description="Follow the readiness sequence from the storyboard">
          <div className="action-row">
            <ButtonLink href="/settings/integrations">Check Auth</ButtonLink>
            <ButtonLink href="/repositories">Go to Repositories</ButtonLink>
            <ButtonLink href="/runs" tone="primary">
              Launch Run
            </ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}
