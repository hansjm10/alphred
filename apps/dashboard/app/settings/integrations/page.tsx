import type { GitHubAuthGate } from '../../ui/github-auth';
import { loadGitHubAuthGate } from '../../ui/load-github-auth-gate';
import { Card } from '../../ui/primitives';
import { AuthStatusPanel } from './auth-status-panel';

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
        <AuthStatusPanel authGate={authGate} />
      </Card>
    </div>
  );
}

export default async function IntegrationsPage({ authGate }: IntegrationsPageProps = {}) {
  const resolvedAuthGate = authGate ?? (await loadGitHubAuthGate());

  return <IntegrationsPageContent authGate={resolvedAuthGate} />;
}
