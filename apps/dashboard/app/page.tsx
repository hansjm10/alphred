import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DashboardRunSummary } from '../src/server/dashboard-contracts';
import { loadDashboardRuns } from './runs/load-dashboard-runs';
import { buildRunDetailHref } from './runs/run-route-utils';
import { isActiveRunStatus, toRunSummaryViewModels } from './runs/run-view-models';
import { AuthRemediation } from './ui/auth-remediation';
import type { GitHubAuthGate } from './ui/github-auth';
import { loadGitHubAuthGate } from './ui/load-github-auth-gate';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from './ui/primitives';

type PageProps = Readonly<{
  activeRuns?: readonly DashboardRunSummary[];
  authGate?: GitHubAuthGate;
}>;

function listDefaultActiveRuns(runs: readonly DashboardRunSummary[]): readonly DashboardRunSummary[] {
  return runs.filter((run) => isActiveRunStatus(run.status));
}

export function OverviewPageContent({ activeRuns, authGate }: Readonly<{
  activeRuns: readonly DashboardRunSummary[];
  authGate: GitHubAuthGate;
}>) {
  const visibleRuns = toRunSummaryViewModels(activeRuns);

  let launchAction: ReactNode;
  if (authGate.canMutate) {
    launchAction = (
      <ButtonLink href="/runs" tone="primary">
        Launch Run
      </ButtonLink>
    );
  } else if (authGate.state === 'checking') {
    launchAction = (
      <ActionButton tone="primary" disabled aria-disabled="true">
        Checking auth...
      </ActionButton>
    );
  } else {
    launchAction = (
      <ButtonLink href="/settings/integrations" tone="primary">
        Connect GitHub
      </ButtonLink>
    );
  }

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
          {visibleRuns.length === 0 ? (
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
              {visibleRuns.map((run) => (
                <li key={run.id}>
                  <div>
                    <Link href={buildRunDetailHref(run.id)}>{`Run #${run.id} ${run.workflowLabel}`}</Link>
                    <p className="meta-text">{`${run.workflowMetaLabel} · ${run.nodeSummaryLabel}`}</p>
                  </div>
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
            {launchAction}
          </div>
          <AuthRemediation authGate={authGate} context={authContextMessage} />
        </Panel>
      </div>
    </div>
  );
}

export default async function Page({ activeRuns, authGate }: PageProps = {}) {
  const [resolvedActiveRuns, resolvedAuthGate] = await Promise.all([
    activeRuns ?? loadDashboardRuns().then((runs) => listDefaultActiveRuns(runs)),
    authGate ?? loadGitHubAuthGate(),
  ]);

  return (
    <OverviewPageContent
      activeRuns={resolvedActiveRuns}
      authGate={resolvedAuthGate}
    />
  );
}
