import { buildRunDetailHref, buildRunWorktreeHref } from '../../run-route-utils';
import {
  resolveRunWorktreePath,
  toRunSummaryViewModel,
  toRunWorktreeViewModels,
} from '../../run-view-models';
import { loadDashboardRunWorktrees } from './load-dashboard-run-worktrees';
import { ButtonLink, Card, Panel } from '../../../ui/primitives';

type RunWorktreePageSearchParams = {
  path?: string | string[];
};

type RunWorktreePageProps = Readonly<{
  params: Promise<{
    runId: string;
  }>;
  searchParams?: RunWorktreePageSearchParams | Promise<RunWorktreePageSearchParams>;
}>;

const WORKTREE_METADATA_NOTICE =
  'File-level diffs are not available in the current backend contract. This view currently shows persisted worktree metadata only.';

export default async function RunWorktreePage({ params, searchParams }: RunWorktreePageProps) {
  const { runId } = await params;
  const resolvedSearchParams = await searchParams;
  const loaded = await loadDashboardRunWorktrees(runId);
  const run = toRunSummaryViewModel(loaded.run);
  const worktrees = toRunWorktreeViewModels(loaded.worktrees);

  if (worktrees.length === 0) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <h2>{`Run #${run.id} worktree`}</h2>
          <p>Metadata-first worktree explorer scoped to this run.</p>
        </section>

        <Card title="No worktree metadata" description="No persisted worktrees were recorded for this run.">
          <p>{WORKTREE_METADATA_NOTICE}</p>
          <div className="action-row">
            <ButtonLink href={buildRunDetailHref(run.id)}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  const selectedPath = resolveRunWorktreePath(worktrees, resolvedSearchParams?.path);
  const selectedWorktree = worktrees.find((worktree) => worktree.path === selectedPath) ?? worktrees[0];

  if (!selectedWorktree) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <h2>{`Run #${run.id} worktree`}</h2>
        </section>
        <Card title="Worktree metadata unavailable">
          <p>No selectable worktree metadata was found.</p>
          <div className="action-row">
            <ButtonLink href={buildRunDetailHref(run.id)}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${run.id} worktree`}</h2>
        <p>{`${run.workflowMetaLabel} with ${worktrees.length} tracked worktree entries.`}</p>
      </section>

      <div className="page-grid">
        <Card title="Tracked worktrees" description="Select a recorded worktree path.">
          <ul className="page-stack" aria-label="Run worktrees">
            {worktrees.map((worktree) => {
              const tone = worktree.path === selectedWorktree.path ? 'primary' : 'secondary';

              return (
                <li key={worktree.id}>
                  <ButtonLink href={buildRunWorktreeHref(run.id, worktree.path)} tone={tone}>
                    {worktree.path}
                  </ButtonLink>
                </li>
              );
            })}
          </ul>
        </Card>

        <Panel title="Worktree metadata" description="Persisted metadata for the selected worktree">
          <p>{WORKTREE_METADATA_NOTICE}</p>
          <ul className="entity-list">
            <li>
              <span>Path</span>
              <span className="meta-text">{selectedWorktree.path}</span>
            </li>
            <li>
              <span>Branch</span>
              <span className="meta-text">{selectedWorktree.branch}</span>
            </li>
            <li>
              <span>Status</span>
              <span className="meta-text">{selectedWorktree.status}</span>
            </li>
            <li>
              <span>Commit</span>
              <span className="meta-text">{selectedWorktree.commitHashLabel}</span>
            </li>
            <li>
              <span>Created</span>
              <span className="meta-text">{selectedWorktree.createdAtLabel}</span>
            </li>
            <li>
              <span>Removed</span>
              <span className="meta-text">{selectedWorktree.removedAtLabel}</span>
            </li>
          </ul>
          <div className="action-row">
            <ButtonLink href={buildRunDetailHref(run.id)}>Back to Run</ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}
