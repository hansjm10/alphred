import Link from 'next/link';
import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';
import { loadDashboardRuns } from './load-dashboard-runs';
import {
  buildRunDetailHref,
  normalizeRunFilter,
  resolveRunFilterHref,
  type RunRouteFilter,
} from './run-route-utils';
import { toRunSummaryViewModels, type RunSummaryViewModel } from './run-view-models';
import { ButtonLink, Card, StatusBadge, Tabs, type TabItem } from '../ui/primitives';

const RUN_FILTER_TABS: readonly TabItem[] = [
  { href: '/runs', label: 'All Runs' },
  { href: '/runs?status=running', label: 'Running' },
  { href: '/runs?status=failed', label: 'Failed' },
];

type RunsPageSearchParams = {
  status?: string | string[];
};

type RunsPageProps = Readonly<{
  searchParams?: RunsPageSearchParams | Promise<RunsPageSearchParams>;
  runs?: readonly DashboardRunSummary[];
}>;

export function RunsPageContent({ runs, searchParams }: Readonly<{
  runs: readonly DashboardRunSummary[];
  searchParams?: RunsPageSearchParams;
}>) {
  const activeFilter = normalizeRunFilter(searchParams?.status);
  const activeHref = resolveRunFilterHref(activeFilter);
  const runViewModels = toRunSummaryViewModels(runs);
  const visibleRuns = filterRuns(runViewModels, activeFilter);

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Run lifecycle</h2>
        <p>Track active work first, then failed runs, then recent completions.</p>
      </section>

      <Tabs items={RUN_FILTER_TABS} activeHref={activeHref} ariaLabel="Run status filters" />

      <Card
        title="Recent runs"
        description="Run-centric routes are canonical for all timeline and worktree investigation."
      >
        {visibleRuns.length === 0 ? (
          <div className="page-stack">
            <p>No runs match this filter.</p>
            <div className="action-row">
              <ButtonLink href="/runs">Clear Filters</ButtonLink>
            </div>
          </div>
        ) : (
          <ul className="entity-list">
            {visibleRuns.map((run) => (
              <li key={run.id}>
                <div>
                  <span>{`#${run.id} ${run.workflowLabel}`}</span>
                  <p className="meta-text">{`${run.workflowMetaLabel} · Started ${run.startedAtLabel}`}</p>
                </div>
                <div className="action-row">
                  <StatusBadge status={run.status} />
                  <Link className="button-link button-link--secondary" href={buildRunDetailHref(run.id)}>
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="meta-text">{`Total tracked runs: ${runViewModels.length}`}</p>
      </Card>
    </div>
  );
}

function filterRuns(
  runs: readonly RunSummaryViewModel[],
  filter: RunRouteFilter,
): readonly RunSummaryViewModel[] {
  if (filter === 'all') {
    return runs;
  }

  return runs.filter((run) => run.status === filter);
}

export default async function RunsPage({ searchParams, runs }: RunsPageProps = {}) {
  const [resolvedSearchParams, resolvedRuns] = await Promise.all([
    searchParams,
    runs ?? loadDashboardRuns(),
  ]);

  return <RunsPageContent runs={resolvedRuns} searchParams={resolvedSearchParams} />;
}
