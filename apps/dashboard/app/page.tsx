import Link from 'next/link';
import type { DashboardRunSummary } from '../src/server/dashboard-contracts';
import { loadDashboardRunSummaries } from './runs/load-dashboard-runs';
import { isActiveRunStatus, sortRunsForDashboard } from './runs/run-summary-utils';
import { AuthRemediation } from './ui/auth-remediation';
import type { GitHubAuthGate } from './ui/github-auth';
import { loadGitHubAuthGate } from './ui/load-github-auth-gate';
import { ButtonLink, Card, Panel, StatusBadge } from './ui/primitives';

type PageProps = Readonly<{
  activeRuns?: readonly DashboardRunSummary[];
  authGate?: GitHubAuthGate;
}>;

export function OverviewPageContent({ activeRuns, authGate }: Readonly<{
  activeRuns: readonly DashboardRunSummary[];
  authGate: GitHubAuthGate;
}>) {
  const authContextMessage =
    authGate.state === 'auth_error'
      ? 'Run launch is blocked because auth checks are failing.'
      : 'Run launch is blocked until GitHub authentication is configured.';

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
              <StatusBadge status={authGate.badge.status} label={authGate.badge.label} />
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
          <p className="meta-text">{`Last checked: ${authGate.checkedAtLabel}`}</p>

          <p className="meta-text">Active runs</p>
          {activeRuns.length === 0 ? (
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
              {activeRuns.map((run) => (
                <li key={run.id}>
                  <Link href={`/runs/${run.id}`}>{`Run #${run.id} ${run.tree.treeKey}`}</Link>
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
          </div>
          <AuthRemediation authGate={authGate} context={authContextMessage} />
        </Panel>
      </div>
    </div>
  );
}

export default async function Page({ activeRuns, authGate }: PageProps = {}) {
  const [resolvedAuthGate, resolvedRuns] = await Promise.all([
    authGate ?? loadGitHubAuthGate(),
    activeRuns ?? loadDashboardRunSummaries(),
  ]);
  const visibleActiveRuns = sortRunsForDashboard(resolvedRuns).filter((run) => isActiveRunStatus(run.status));

  return (
    <OverviewPageContent
      activeRuns={visibleActiveRuns}
      authGate={resolvedAuthGate}
    />
  );
}
