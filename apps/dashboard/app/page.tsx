import { ButtonLink, Card, Panel, StatusBadge } from './ui/primitives';

export default function Page() {
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
