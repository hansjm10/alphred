'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type {
  DashboardRepositoryState,
  DashboardRunExecutionScope,
  DashboardRunLaunchResult,
  DashboardRunNodeSelector,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';
import { AuthRemediation } from '../ui/auth-remediation';
import type { GitHubAuthGate } from '../ui/github-auth';
import { ActionButton, Card, Panel, StatusBadge, Tabs, type TabItem } from '../ui/primitives';
import {
  buildRunsListHref,
  normalizeRunFilter,
  type RunRouteFilter,
  type RunRouteTimeWindow,
} from './run-route-fixtures';
import { isActiveRunStatus, sortRunsForDashboard } from './run-summary-utils';

type RunsPageContentProps = Readonly<{
  runs: readonly DashboardRunSummary[];
  workflows: readonly DashboardWorkflowTreeSummary[];
  repositories: readonly DashboardRepositoryState[];
  authGate: GitHubAuthGate;
  activeFilter: RunRouteFilter;
  activeRepositoryName: string | null;
  activeWorkflowKey: string | null;
  activeWindow: RunRouteTimeWindow;
}>;

type LaunchBannerState = {
  workflowRunId: number;
  runStatus: DashboardRunSummary['status'] | null;
};

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const DEFAULT_RUN_LIST_LIMIT = 50;
const LAUNCH_RESULT_MODES = new Set<DashboardRunLaunchResult['mode']>(['async', 'sync']);
const LAUNCH_RESULT_STATUSES = new Set<DashboardRunLaunchResult['status']>(['accepted', 'completed']);
const LAUNCH_RESULT_RUN_STATUSES = new Set<DashboardRunLaunchResult['runStatus']>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
const RUN_EXECUTION_SCOPE_SET = new Set<DashboardRunExecutionScope>(['full', 'single_node']);
const NODE_SELECTOR_TYPE_SET = new Set<DashboardRunNodeSelector['type']>(['next_runnable', 'node_key']);

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

function includesRunByFilter(run: DashboardRunSummary, filter: RunRouteFilter): boolean {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'running') {
    return isActiveRunStatus(run.status);
  }

  return run.status === 'failed';
}

function resolveRunTimestampMs(run: DashboardRunSummary): number | null {
  const raw = run.completedAt ?? run.startedAt ?? run.createdAt;
  const timestamp = new Date(raw).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function resolveRunDurationMs(run: DashboardRunSummary): number | null {
  if (!run.startedAt || !run.completedAt) {
    return null;
  }

  const startedAt = new Date(run.startedAt).getTime();
  const completedAt = new Date(run.completedAt).getTime();
  if (Number.isNaN(startedAt) || Number.isNaN(completedAt) || completedAt < startedAt) {
    return null;
  }

  return completedAt - startedAt;
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  if (totalMinutes > 0) {
    return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function resolveMedianDurationLabel(runs: readonly DashboardRunSummary[]): string {
  const durations = runs
    .map(resolveRunDurationMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => left - right);

  if (durations.length === 0) {
    return '—';
  }

  const midpoint = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 1 ? durations[midpoint] : (durations[midpoint - 1] + durations[midpoint]) / 2;

  return formatDurationMs(median);
}

function resolveWindowCutoffMs(window: RunRouteTimeWindow, nowMs: number): number | null {
  switch (window) {
    case '24h':
      return nowMs - 24 * 60 * 60 * 1000;
    case '7d':
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return nowMs - 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
  }
}

function includesRunByWindow(run: DashboardRunSummary, window: RunRouteTimeWindow, nowMs: number): boolean {
  const cutoff = resolveWindowCutoffMs(window, nowMs);
  if (cutoff === null) {
    return true;
  }

  const timestamp = resolveRunTimestampMs(run);
  if (timestamp === null) {
    return true;
  }

  return timestamp >= cutoff;
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

function parseLaunchResult(payload: unknown): DashboardRunLaunchResult | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const workflowRunId = candidate.workflowRunId;
  const mode = candidate.mode;
  const status = candidate.status;
  const runStatus = candidate.runStatus;
  const executionOutcome = candidate.executionOutcome;
  const executedNodes = candidate.executedNodes;

  if (typeof workflowRunId !== 'number' || !Number.isInteger(workflowRunId)) {
    return null;
  }

  if (typeof mode !== 'string' || !LAUNCH_RESULT_MODES.has(mode as DashboardRunLaunchResult['mode'])) {
    return null;
  }

  if (
    typeof status !== 'string' ||
    !LAUNCH_RESULT_STATUSES.has(status as DashboardRunLaunchResult['status'])
  ) {
    return null;
  }

  if (
    typeof runStatus !== 'string' ||
    !LAUNCH_RESULT_RUN_STATUSES.has(runStatus as DashboardRunLaunchResult['runStatus'])
  ) {
    return null;
  }

  if (executionOutcome !== null && typeof executionOutcome !== 'string') {
    return null;
  }

  if (executedNodes !== null && (typeof executedNodes !== 'number' || !Number.isInteger(executedNodes))) {
    return null;
  }

  return {
    workflowRunId,
    mode: mode as DashboardRunLaunchResult['mode'],
    status: status as DashboardRunLaunchResult['status'],
    runStatus: runStatus as DashboardRunLaunchResult['runStatus'],
    executionOutcome,
    executedNodes,
  };
}

function buildNodeSelectorPayload(
  executionScope: DashboardRunExecutionScope,
  nodeSelectorType: DashboardRunNodeSelector['type'],
  nodeKey: string,
): DashboardRunNodeSelector | undefined {
  if (executionScope !== 'single_node') {
    return undefined;
  }

  if (nodeSelectorType === 'node_key') {
    return {
      type: 'node_key',
      nodeKey: nodeKey.trim(),
    };
  }

  return {
    type: 'next_runnable',
  };
}

async function postLaunchRequest(params: {
  selectedTreeKey: string;
  selectedRepositoryName: string;
  branch: string;
  executionScope: DashboardRunExecutionScope;
  nodeSelectorType: DashboardRunNodeSelector['type'];
  nodeKey: string;
}): Promise<DashboardRunLaunchResult> {
  const selectorPayload = buildNodeSelectorPayload(params.executionScope, params.nodeSelectorType, params.nodeKey);
  const response = await fetch('/api/dashboard/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      treeKey: params.selectedTreeKey,
      repositoryName: params.selectedRepositoryName || undefined,
      branch: params.branch.trim() || undefined,
      executionMode: 'async',
      executionScope: params.executionScope,
      nodeSelector: selectorPayload,
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Run launch failed'));
  }

  const parsedResult = parseLaunchResult(payload);
  if (parsedResult === null) {
    throw new Error('Run launch response was malformed.');
  }
  return parsedResult;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function resolvePostLaunchBannerState(
  refreshRunState: () => Promise<readonly DashboardRunSummary[]>,
  workflowRunId: number,
): Promise<{ runStatus: DashboardRunSummary['status'] | null; launchRefreshWarning: string | null }> {
  try {
    const refreshedRuns = await refreshRunState();
    const refreshedLaunchRun = refreshedRuns.find((run) => run.id === workflowRunId);
    return {
      runStatus: refreshedLaunchRun?.status ?? null,
      launchRefreshWarning: null,
    };
  } catch (error) {
    return {
      runStatus: null,
      launchRefreshWarning: `Run accepted, but lifecycle refresh failed: ${toErrorMessage(
        error,
        'Unable to refresh run lifecycle state.',
      )}`,
    };
  }
}

export function RunsPageContent({
  runs,
  workflows,
  repositories,
  authGate,
  activeFilter,
  activeRepositoryName,
  activeWorkflowKey,
  activeWindow,
}: RunsPageContentProps) {
  const router = useRouter();
  const [runState, setRunState] = useState<readonly DashboardRunSummary[]>(sortRunsForDashboard(runs));
  const [selectedTreeKey, setSelectedTreeKey] = useState<string>(workflows[0]?.treeKey ?? '');
  const [selectedRepositoryName, setSelectedRepositoryName] = useState<string>(activeRepositoryName ?? '');
  const [branch, setBranch] = useState<string>('');
  const [executionScope, setExecutionScope] = useState<DashboardRunExecutionScope>('full');
  const [nodeSelectorType, setNodeSelectorType] = useState<DashboardRunNodeSelector['type']>('next_runnable');
  const [nodeKey, setNodeKey] = useState<string>('');
  const [isLaunching, setIsLaunching] = useState<boolean>(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchRefreshWarning, setLaunchRefreshWarning] = useState<string | null>(null);
  const [launchResult, setLaunchResult] = useState<LaunchBannerState | null>(null);

  const launchBlockedReason = getLaunchBlockedReason(authGate, workflows);
  const nowMs = Date.now();
  const normalizedFilter = normalizeRunFilter(activeFilter);
  const activeHref = buildRunsListHref({
    status: normalizedFilter,
    workflow: activeWorkflowKey,
    repository: activeRepositoryName,
    window: activeWindow,
  });
  const nodeSelectorRequiresNodeKey = executionScope === 'single_node' && nodeSelectorType === 'node_key';
  const launchDisabled =
    isLaunching ||
    launchBlockedReason !== null ||
    selectedTreeKey.trim().length === 0 ||
    (nodeSelectorRequiresNodeKey && nodeKey.trim().length === 0);
  const launchButtonLabel = isLaunching ? 'Launching...' : 'Launch Run';

  const clonedRepositories = useMemo(
    () => repositories.filter((repository) => repository.cloneStatus === 'cloned'),
    [repositories],
  );

  const runFilterTabs = useMemo<readonly TabItem[]>(() => ([
    {
      href: buildRunsListHref({
        status: 'all',
        workflow: activeWorkflowKey,
        repository: activeRepositoryName,
        window: activeWindow,
      }),
      label: 'All Runs',
    },
    {
      href: buildRunsListHref({
        status: 'running',
        workflow: activeWorkflowKey,
        repository: activeRepositoryName,
        window: activeWindow,
      }),
      label: 'Running',
    },
    {
      href: buildRunsListHref({
        status: 'failed',
        workflow: activeWorkflowKey,
        repository: activeRepositoryName,
        window: activeWindow,
      }),
      label: 'Failed',
    },
  ]), [activeRepositoryName, activeWindow, activeWorkflowKey]);

  const filteredRunsForKpis = useMemo(() => {
    return runState.filter((run) => {
      if (activeWorkflowKey && run.tree.treeKey !== activeWorkflowKey) {
        return false;
      }

      if (activeRepositoryName && run.repository?.name !== activeRepositoryName) {
        return false;
      }

      return includesRunByWindow(run, activeWindow, nowMs);
    });
  }, [activeRepositoryName, activeWindow, activeWorkflowKey, nowMs, runState]);

  const visibleRuns = useMemo(() => {
    return filteredRunsForKpis.filter((run) => includesRunByFilter(run, normalizedFilter));
  }, [filteredRunsForKpis, normalizedFilter]);

  const activeRunCount = useMemo(
    () => filteredRunsForKpis.filter((run) => isActiveRunStatus(run.status)).length,
    [filteredRunsForKpis],
  );

  const failureCount24h = useMemo(() => {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    return filteredRunsForKpis.filter((run) => {
      if (run.status !== 'failed') {
        return false;
      }

      const timestamp = resolveRunTimestampMs(run);
      return timestamp !== null && timestamp >= cutoff;
    }).length;
  }, [filteredRunsForKpis, nowMs]);

  const medianDurationLabel = useMemo(
    () => resolveMedianDurationLabel(filteredRunsForKpis),
    [filteredRunsForKpis],
  );

  const hasActiveFilters =
    normalizedFilter !== 'all' ||
    activeWorkflowKey !== null ||
    activeRepositoryName !== null ||
    activeWindow !== 'all';

  useEffect(() => {
    setRunState(sortRunsForDashboard(runs));
  }, [runs]);

  useEffect(() => {
    setSelectedRepositoryName(activeRepositoryName ?? '');
  }, [activeRepositoryName]);

  async function refreshRunState(): Promise<readonly DashboardRunSummary[]> {
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

    const refreshedRuns = sortRunsForDashboard((payload as { runs: DashboardRunSummary[] }).runs);
    setRunState(refreshedRuns);
    return refreshedRuns;
  }

  async function handleLaunchRun(): Promise<void> {
    if (launchDisabled) {
      return;
    }

    setLaunchError(null);
    setLaunchRefreshWarning(null);
    setLaunchResult(null);
    setIsLaunching(true);

    try {
      const parsedResult = await postLaunchRequest({
        selectedTreeKey,
        selectedRepositoryName,
        branch,
        executionScope,
        nodeSelectorType,
        nodeKey,
      });
      const postLaunchBanner = await resolvePostLaunchBannerState(refreshRunState, parsedResult.workflowRunId);
      setLaunchResult({
        workflowRunId: parsedResult.workflowRunId,
        runStatus: postLaunchBanner.runStatus,
      });
      setLaunchRefreshWarning(postLaunchBanner.launchRefreshWarning);
    } catch (error) {
      setLaunchResult(null);
      setLaunchError(toErrorMessage(error, 'Run launch failed.'));
    } finally {
      setIsLaunching(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Run lifecycle</h2>
        <p>Launch full or single-node runs in async mode and monitor lifecycle state from persisted data.</p>
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

            <label className="run-launch-form__field" htmlFor="run-launch-execution-scope">
              <span className="meta-text">Execution scope</span>
              <select
                id="run-launch-execution-scope"
                value={executionScope}
                disabled={launchBlockedReason !== null}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value as DashboardRunExecutionScope;
                  if (!RUN_EXECUTION_SCOPE_SET.has(nextValue)) {
                    return;
                  }
                  setExecutionScope(nextValue);
                }}
              >
                <option value="full">Full workflow</option>
                <option value="single_node">Single node</option>
              </select>
            </label>

            {executionScope === 'single_node' ? (
              <label className="run-launch-form__field" htmlFor="run-launch-node-selector">
                <span className="meta-text">Node selector</span>
                <select
                  id="run-launch-node-selector"
                  value={nodeSelectorType}
                  disabled={launchBlockedReason !== null}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value as DashboardRunNodeSelector['type'];
                    if (!NODE_SELECTOR_TYPE_SET.has(nextValue)) {
                      return;
                    }
                    setNodeSelectorType(nextValue);
                  }}
                >
                  <option value="next_runnable">Next runnable</option>
                  <option value="node_key">Node key</option>
                </select>
              </label>
            ) : null}

            {executionScope === 'single_node' && nodeSelectorType === 'node_key' ? (
              <label className="run-launch-form__field" htmlFor="run-launch-node-key">
                <span className="meta-text">Node key</span>
                <input
                  id="run-launch-node-key"
                  value={nodeKey}
                  disabled={launchBlockedReason !== null}
                  onChange={(event) => {
                    setNodeKey(event.currentTarget.value);
                  }}
                  placeholder="design"
                />
              </label>
            ) : null}

            <div className="action-row">
              <ActionButton
                tone="primary"
                type="submit"
                disabled={launchDisabled}
                aria-disabled={launchDisabled}
              >
                {launchButtonLabel}
              </ActionButton>
              <span className="meta-text">
                {executionScope === 'single_node'
                  ? 'Launch runs one node attempt, then terminalizes the run.'
                  : 'Launch defaults to async mode.'}
              </span>
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
              {launchResult.runStatus === null
                ? `Run #${launchResult.workflowRunId} accepted. `
                : `Run #${launchResult.workflowRunId} accepted. Current status: ${launchResult.runStatus}. `}
              <Link className="run-inline-link" href={`/runs/${launchResult.workflowRunId}`}>
                Open run detail
              </Link>
              {launchRefreshWarning ? (
                <span className="run-launch-banner__note">{` ${launchRefreshWarning}`}</span>
              ) : null}
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

		      <Card title="Runs" description="Filter run activity and open detail timelines.">
		        <section className="run-filter-bar" aria-label="Run filters">
		          <div className="run-filter-bar__fields">
		            <label className="run-filter-bar__field" htmlFor="runs-filter-workflow">
		              <span className="meta-text">Workflow filter</span>
		              <select
	                id="runs-filter-workflow"
	                value={activeWorkflowKey ?? ''}
	                onChange={(event) => {
	                  const workflow = event.currentTarget.value.trim();
	                  router.push(buildRunsListHref({
	                    status: normalizedFilter,
	                    workflow: workflow.length === 0 ? null : workflow,
	                    repository: activeRepositoryName,
	                    window: activeWindow,
	                  }));
	                }}
	              >
	                <option value="">All workflows</option>
	                {workflows.map((workflow) => (
	                  <option key={`${workflow.treeKey}-${workflow.id}`} value={workflow.treeKey}>
	                    {workflow.name}
	                  </option>
	                ))}
	              </select>
	            </label>

	            <label className="run-filter-bar__field" htmlFor="runs-filter-repository">
	              <span className="meta-text">Repository filter</span>
	              <select
	                id="runs-filter-repository"
	                value={activeRepositoryName ?? ''}
	                onChange={(event) => {
	                  const repository = event.currentTarget.value.trim();
	                  router.push(buildRunsListHref({
	                    status: normalizedFilter,
	                    workflow: activeWorkflowKey,
	                    repository: repository.length === 0 ? null : repository,
	                    window: activeWindow,
	                  }));
	                }}
	              >
	                <option value="">All repositories</option>
	                {clonedRepositories.map((repository) => (
	                  <option key={repository.id} value={repository.name}>
	                    {repository.name}
	                  </option>
	                ))}
	              </select>
	            </label>

	            <label className="run-filter-bar__field" htmlFor="runs-filter-window">
	              <span className="meta-text">Time window</span>
	              <select
	                id="runs-filter-window"
	                value={activeWindow}
	                onChange={(event) => {
	                  router.push(buildRunsListHref({
	                    status: normalizedFilter,
	                    workflow: activeWorkflowKey,
	                    repository: activeRepositoryName,
	                    window: event.currentTarget.value as RunRouteTimeWindow,
	                  }));
	                }}
	              >
	                <option value="all">All time</option>
	                <option value="24h">Last 24h</option>
	                <option value="7d">Last 7d</option>
	                <option value="30d">Last 30d</option>
	              </select>
	            </label>
	          </div>

		          {hasActiveFilters ? (
		            <div className="action-row">
		              <Link className="button-link button-link--secondary" href="/runs">
		                Clear Filters
		              </Link>
		            </div>
		          ) : null}
		        </section>

	        <Tabs items={runFilterTabs} activeHref={activeHref} ariaLabel="Run status filters" />

	        {visibleRuns.length === 0 ? (
	          <div className="page-stack">
	            <p>{hasActiveFilters ? 'No runs match these filters.' : 'No runs are available yet.'}</p>
	            {hasActiveFilters ? (
	              <div className="action-row">
	                <Link className="button-link button-link--secondary" href="/runs">
	                  Clear Filters
	                </Link>
	              </div>
	            ) : null}
	          </div>
	        ) : (
	          <div className="runs-table-wrapper">
	            <table className="runs-table runs-table--clickable">
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
	                  <tr
	                    key={run.id}
	                    className="runs-table__row"
	                    tabIndex={0}
	                    onClick={() => {
	                      router.push(`/runs/${run.id}`);
	                    }}
	                    onKeyDown={(event) => {
	                      if (event.key === 'Enter' || event.key === ' ') {
	                        event.preventDefault();
	                        router.push(`/runs/${run.id}`);
	                      }
	                    }}
	                  >
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
	                      <Link
	                        className="button-link button-link--secondary"
	                        href={`/runs/${run.id}`}
	                        onClick={(event) => {
	                          event.stopPropagation();
	                        }}
	                      >
	                        Open
	                      </Link>
	                    </td>
	                  </tr>
	                ))}
	              </tbody>
	            </table>
	          </div>
	        )}

	        <dl className="run-kpi-strip" aria-label="Run KPIs">
	          <div className="run-kpi-strip__item">
	            <dt>Active</dt>
	            <dd>{activeRunCount}</dd>
	          </div>
	          <div className="run-kpi-strip__item">
	            <dt>Failures (24h)</dt>
	            <dd>{failureCount24h}</dd>
	          </div>
	          <div className="run-kpi-strip__item">
	            <dt>Median duration</dt>
	            <dd>{medianDurationLabel}</dd>
	          </div>
	        </dl>
	      </Card>
	    </div>
	  );
}
