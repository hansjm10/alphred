import { Card, StatusBadge, Tabs, type TabItem } from '../ui/primitives';

const RUN_FILTER_TABS: readonly TabItem[] = [
  { href: '/runs', label: 'All Runs' },
  { href: '/runs?status=running', label: 'Running' },
  { href: '/runs?status=failed', label: 'Failed' },
];

export default function RunsPage() {
  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Run lifecycle</h2>
        <p>Track active work first, then failed runs, then recent completions.</p>
      </section>

      <Tabs items={RUN_FILTER_TABS} activeHref="/runs" ariaLabel="Run status filters" />

      <Card title="Recent runs" description="Shared status vocabulary from the storyboard">
        <ul className="entity-list">
          <li>
            <span>#412 demo-tree</span>
            <StatusBadge status="running" label="Running" />
          </li>
          <li>
            <span>#411 demo-tree</span>
            <StatusBadge status="completed" label="Completed" />
          </li>
          <li>
            <span>#410 demo-tree</span>
            <StatusBadge status="paused" label="Paused" />
          </li>
        </ul>
      </Card>
    </div>
  );
}
