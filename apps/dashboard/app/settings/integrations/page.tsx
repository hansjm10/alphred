import { ButtonLink, Card, StatusBadge } from '../../ui/primitives';

export default function IntegrationsPage() {
  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Integrations status</h2>
        <p>Check credentials before sync and run mutations.</p>
      </section>

      <Card title="GitHub authentication" description="Auth gate source for repo and run actions">
        <ul className="entity-list">
          <li>
            <span>Current state</span>
            <StatusBadge status="completed" label="Authenticated" />
          </li>
          <li>
            <span>Last checked</span>
            <span className="meta-text">just now</span>
          </li>
        </ul>

        <div className="action-row">
          <ButtonLink href="/settings/integrations" tone="primary">
            Check Auth
          </ButtonLink>
          <ButtonLink href="/repositories">Back to Repositories</ButtonLink>
        </div>
      </Card>
    </div>
  );
}
