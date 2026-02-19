'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type {
  DashboardRepositoryState,
  DashboardRunLaunchResult,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';
import { AuthRemediation } from '../ui/auth-remediation';
import type { GitHubAuthGate } from '../ui/github-auth';
import { ActionButton, Card, Panel, StatusBadge, Tabs, type TabItem } from '../ui/primitives';
import { normalizeRunFilter, resolveRunFilterHref, type RunRouteFilter } from './run-route-fixtures';

type RunsPageContentProps = Readonly<{
  runs: readonly DashboardRunSummary[];
  workflows: readonly DashboardWorkflowTreeSummary[];
  repositories: readonly DashboardRepositoryState[];
  authGate: GitHubAuthGate;
  activeFilter: RunRouteFilter;
}>;

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const RUN_FILTER_TABS: readonly TabItem[] = [
  { href: '/runs', label: 'All Runs' },
  { href: '/runs?status=running', label: 'Running' },
  { href: '/runs?status=failed', label: 'Failed' },
];

const DEFAULT_RUN_LIST_LIMIT = 50;
const ACTIVE_RUN_STATUSES = new Set<DashboardRunSummary['status']>(['pending', 'running', 'paused']);

function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ErrorEnvelope).error === 'object' &&
    (payload as ErrorEnvelope).error !== null &&
    typeof (payload as ErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

function normalizeDateTimeLabel(value: string | null, fallback: string): string {
  if (value === null) {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function sortRunsForDashboard(
  input: readonly DashboardRunSummary[],
): DashboardRunSummary[] {
  const statusPriority: Record<DashboardRunSummary['status'], number> = {
    running: 0,
    paused: 1,
    pending: 2,
    failed: 3,
    completed: 4,
    cancelled: 5,
  };

  return [...input].sort((left, right) => {
    const statusDifference = statusPriority[left.status] - statusPriority[right.status];
    if (statusDifference !== 0) {
      return statusDifference;
    }

    const leftTimestamp = new Date(left.startedAt ?? left.createdAt).getTime();
    const rightTimestamp = new Date(right.startedAt ?? right.createdAt).getTime();
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return right.id - left.id;
  });
}

function includesRunByFilter(run: DashboardRunSummary, filter: RunRouteFilter): boolean {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'running') {
    return ACTIVE_RUN_STATUSES.has(run.status);
  }

  return run.status === 'failed';
}

function formatNodeSummary(run: DashboardRunSummary): string {
  const { nodeSummary } = run;
  return [
    `P ${nodeSummary.pending}`,
    `R ${nodeSummary.running}`,
    `C ${nodeSummary.completed}`,
    `F ${nodeSummary.failed}`,
  ].join(' · ');
}

function getLaunchBlockedReason(
  authGate: GitHubAuthGate,
  workflows: readonly DashboardWorkflowTreeSummary[],
): string | null {
  if (!authGate.canMutate) {
    return 'Run launch is blocked until GitHub authentication is restored.';
  }

  if (workflows.length === 0) {
    return 'No workflow trees are registered yet. Add workflows before launching runs.';
  }

  return null;
}

export function RunsPageContent({
  runs,
  workflows,
  repositories,
  authGate,
  activeFilter,
}: RunsPageContentProps) {
  const [runState, setRunState] = useState<readonly DashboardRunSummary[]>(sortRunsForDashboard(runs));
  const [selectedTreeKey, setSelectedTreeKey] = useState<string>(workflows[0]?.treeKey ?? '');
  const [selectedRepositoryName, setSelectedRepositoryName] = useState<string>('');
  const [branch, setBranch] = useState<string>('');
  const [isLaunching, setIsLaunching] = useState<boolean>(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<DashboardRunLaunchResult | null>(null);

  const launchBlockedReason = getLaunchBlockedReason(authGate, workflows);
  const activeHref = resolveRunFilterHref(normalizeRunFilter(activeFilter));
  const launchDisabled = isLaunching || launchBlockedReason !== null || selectedTreeKey.trim().length === 0;
  const launchButtonLabel = isLaunching ? 'Launching...' : 'Launch Run';

  const clonedRepositories = useMemo(
    () => repositories.filter((repository) => repository.cloneStatus === 'cloned'),
    [repositories],
  );

  const visibleRuns = useMemo(
    () => runState.filter((run) => includesRunByFilter(run, activeFilter)),
    [activeFilter, runState],
  );

  useEffect(() => {
    setRunState(sortRunsForDashboard(runs));
  }, [runs]);

  async function refreshRunState(): Promise<void> {
    const response = await fetch(`/api/dashboard/runs?limit=${DEFAULT_RUN_LIST_LIMIT}`, { method: 'GET' });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh run lifecycle state'));
    }

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('runs' in payload) ||
      !Array.isArray((payload as { runs?: unknown }).runs)
    ) {
      throw new Error('Run refresh response was malformed.');
    }

    setRunState(sortRunsForDashboard((payload as { runs: DashboardRunSummary[] }).runs));
  }

  async function handleLaunchRun(): Promise<void> {
    if (launchDisabled) {
      return;
    }

    setLaunchError(null);
    setLaunchResult(null);
    setIsLaunching(true);

    try {
      const response = await fetch('/api/dashboard/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          treeKey: selectedTreeKey,
          repositoryName: selectedRepositoryName || undefined,
          branch: branch.trim() || undefined,
          executionMode: 'async',
        }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Run launch failed'));
      }

      setLaunchResult(payload as DashboardRunLaunchResult);
      await refreshRunState();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Run launch failed.';
      setLaunchError(message);
    } finally {
      setIsLaunching(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Run lifecycle</h2>
        <p>Launch new runs in safe async mode and monitor lifecycle state from persisted data.</p>
      </section>

      <div className="page-grid">
        <Card title="Launch run" description="Tree selection + repository context where applicable.">
          <form
            className="run-launch-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLaunchRun();
            }}
          >
            <label className="run-launch-form__field" htmlFor="run-launch-workflow">
              <span className="meta-text">Workflow</span>
              <select
                id="run-launch-workflow"
                value={selectedTreeKey}
                disabled={launchBlockedReason !== null || workflows.length === 0}
                onChange={(event) => {
                  setSelectedTreeKey(event.currentTarget.value);
                }}
              >
                {workflows.length === 0 ? <option value="">No workflows available</option> : null}
                {workflows.map((workflow) => (
                  <option key={`${workflow.treeKey}-${workflow.id}`} value={workflow.treeKey}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="run-launch-form__field" htmlFor="run-launch-repository">
              <span className="meta-text">Repository context</span>
              <select
                id="run-launch-repository"
                value={selectedRepositoryName}
                disabled={launchBlockedReason !== null}
                onChange={(event) => {
                  setSelectedRepositoryName(event.currentTarget.value);
                }}
              >
                <option value="">No repository context</option>
                {clonedRepositories.map((repository) => (
                  <option key={repository.id} value={repository.name}>
                    {repository.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="run-launch-form__field" htmlFor="run-launch-branch">
              <span className="meta-text">Branch (optional)</span>
              <input
                id="run-launch-branch"
                value={branch}
                disabled={launchBlockedReason !== null || selectedRepositoryName.length === 0}
                onChange={(event) => {
                  setBranch(event.currentTarget.value);
                }}
                placeholder="feature/dashboard-run-control"
              />
            </label>

            <div className="action-row">
              <ActionButton
                tone="primary"
                type="submit"
                disabled={launchDisabled}
                aria-disabled={launchDisabled}
              >
                {launchButtonLabel}
              </ActionButton>
              <span className="meta-text">Launch defaults to async mode.</span>
            </div>
          </form>

          {launchBlockedReason ? <p className="meta-text">{launchBlockedReason}</p> : null}
          {launchError ? (
            <p className="run-launch-banner run-launch-banner--error" role="alert">
              {launchError}
            </p>
          ) : null}
          {launchResult ? (
            <output className="run-launch-banner run-launch-banner--success" aria-live="polite">
              {`Run #${launchResult.workflowRunId} accepted with status ${launchResult.runStatus}. `}
              <Link className="run-inline-link" href={`/runs/${launchResult.workflowRunId}`}>
                Open run detail
              </Link>
            </output>
          ) : null}
        </Card>

        <Panel title="Launch readiness" description="Invalid actions are blocked and paired with remediation.">
          <ul className="entity-list">
            <li>
              <span>GitHub auth</span>
              <StatusBadge status={authGate.badge.status} label={authGate.badge.label} />
            </li>
            <li>
              <span>Workflow trees</span>
              <span className="meta-text">{workflows.length}</span>
            </li>
            <li>
              <span>Launch-ready repos</span>
              <span className="meta-text">{clonedRepositories.length}</span>
            </li>
          </ul>
          <AuthRemediation
            authGate={authGate}
            context="Run launch is blocked until GitHub authentication is available."
          />
        </Panel>
      </div>

      <Tabs items={RUN_FILTER_TABS} activeHref={activeHref} ariaLabel="Run status filters" />

      <Card title="Recent runs" description="Run lifecycle and node progress from persisted snapshots.">
        {visibleRuns.length === 0 ? (
          <div className="page-stack">
            <p>No runs match this filter.</p>
            <div className="action-row">
              <Link className="button-link button-link--secondary" href="/runs">
                Clear Filters
              </Link>
            </div>
          </div>
        ) : (
          <div className="runs-table-wrapper">
            <table className="runs-table">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Node lifecycle</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <p>{`#${run.id} ${run.tree.name}`}</p>
                      <p className="meta-text">{run.tree.treeKey}</p>
                    </td>
                    <td className="meta-text">{run.repository?.name ?? 'Not attached'}</td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="meta-text">{normalizeDateTimeLabel(run.startedAt, 'Not started')}</td>
                    <td className="meta-text">{normalizeDateTimeLabel(run.completedAt, 'In progress')}</td>
                    <td className="meta-text">{formatNodeSummary(run)}</td>
                    <td>
                      <Link className="button-link button-link--secondary" href={`/runs/${run.id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
