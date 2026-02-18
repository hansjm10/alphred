import { AuthRemediation } from '../../ui/auth-remediation';
import type { GitHubAuthGate } from '../../ui/github-auth';
import { loadGitHubAuthGate } from '../../ui/load-github-auth-gate';
import { ButtonLink, Card, StatusBadge } from '../../ui/primitives';

type IntegrationsPageProps = Readonly<{
  authGate?: GitHubAuthGate;
}>;

export function IntegrationsPageContent({ authGate }: Readonly<{ authGate: GitHubAuthGate }>) {
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
            <StatusBadge status={authGate.badge.status} label={authGate.badge.label} />
          </li>
          <li>
            <span>Last checked</span>
            <span className="meta-text">{authGate.checkedAtLabel}</span>
          </li>
          {authGate.user ? (
            <li>
              <span>Identity</span>
              <span className="meta-text">{authGate.user}</span>
            </li>
          ) : null}
          {authGate.scopes.length > 0 ? (
            <li>
              <span>Scopes</span>
              <span className="meta-text">{authGate.scopes.join(', ')}</span>
            </li>
          ) : null}
        </ul>
        <p className="meta-text">{authGate.detail}</p>

        <div className="action-row">
          <ButtonLink href="/settings/integrations" tone="primary">
            Check Auth
          </ButtonLink>
          <ButtonLink href="/repositories">Back to Repositories</ButtonLink>
          <ButtonLink href="/runs">Back to Runs</ButtonLink>
        </div>
        <AuthRemediation
          authGate={authGate}
          context="Repository sync and run launch are gated until GitHub auth is restored."
        />
      </Card>
    </div>
  );
}

export default async function IntegrationsPage({ authGate }: IntegrationsPageProps = {}) {
  const resolvedAuthGate = authGate ?? (await loadGitHubAuthGate());

  return <IntegrationsPageContent authGate={resolvedAuthGate} />;
}
