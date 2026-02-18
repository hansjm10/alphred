import Link from 'next/link';
import {
  RUN_ROUTE_FIXTURES,
  buildRunDetailHref,
  listRunsForFilter,
  normalizeRunFilter,
  resolveRunFilterHref,
} from './run-route-fixtures';
import { ButtonLink, Card, StatusBadge, Tabs, type TabItem } from '../ui/primitives';

const RUN_FILTER_TABS: readonly TabItem[] = [
  { href: '/runs', label: 'All Runs' },
  { href: '/runs?status=running', label: 'Running' },
  { href: '/runs?status=failed', label: 'Failed' },
];

type RunsPageProps = Readonly<{
  searchParams?: {
    status?: string | string[];
  };
}>;

export default function RunsPage({ searchParams }: RunsPageProps) {
  const activeFilter = normalizeRunFilter(searchParams?.status);
  const activeHref = resolveRunFilterHref(activeFilter);
  const visibleRuns = listRunsForFilter(activeFilter);

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
                  <span>{`#${run.id} ${run.workflow}`}</span>
                  <p className="meta-text">{run.repository}</p>
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

        <p className="meta-text">{`Total tracked runs: ${RUN_ROUTE_FIXTURES.length}`}</p>
      </Card>
    </div>
  );
}
