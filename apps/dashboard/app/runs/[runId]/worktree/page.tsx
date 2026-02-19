import { notFound } from 'next/navigation';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { loadDashboardRunDetail } from '../../load-dashboard-runs';
import { buildRunWorktreeHref, findRunByParam, resolveWorktreePath } from '../../run-route-fixtures';
import { ButtonLink, Card, Panel } from '../../../ui/primitives';

type RunWorktreePageProps = Readonly<{
  params: Promise<{
    runId: string;
  }>;
  searchParams?: Promise<{
    path?: string | string[];
  }>;
}>;

function parseRunId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function resolvePrimaryWorktree(detail: DashboardRunDetail): DashboardRunDetail['worktrees'][number] | null {
  return detail.worktrees.find((worktree) => worktree.status === 'active') ?? detail.worktrees[0] ?? null;
}

export default async function RunWorktreePage({ params, searchParams }: RunWorktreePageProps) {
  const { runId } = await params;
  const resolvedSearchParams = await searchParams;
  const fixtureRun = findRunByParam(runId);
  if (fixtureRun !== null) {
    if (fixtureRun.worktree.files.length === 0) {
      return (
        <div className="page-stack">
          <section className="page-heading">
            <h2>{`Run #${fixtureRun.id} worktree`}</h2>
            <p>Changed-file explorer scoped to this run.</p>
          </section>

          <Card title="No changed files" description="This run completed without file changes.">
            <div className="action-row">
              <ButtonLink href={`/runs/${fixtureRun.id}`}>Back to Run</ButtonLink>
            </div>
          </Card>
        </div>
      );
    }

    const selectedPath = resolveWorktreePath(fixtureRun, resolvedSearchParams?.path);
    const fallbackFile = fixtureRun.worktree.files[0];
    if (!fallbackFile) {
      notFound();
    }

    const selectedFile = fixtureRun.worktree.files.find((file) => file.path === selectedPath) ?? fallbackFile;

    return (
      <div className="page-stack">
        <section className="page-heading">
          <h2>{`Run #${fixtureRun.id} worktree`}</h2>
          <p>{`Branch ${fixtureRun.worktree.branch} with ${fixtureRun.worktree.files.length} tracked files.`}</p>
        </section>

        <div className="page-grid">
          <Card title="Changed files" description="Default selection is the first changed file.">
            <ul className="page-stack" aria-label="Worktree files">
              {fixtureRun.worktree.files.map((file) => {
                const tone = file.path === selectedFile.path ? 'primary' : 'secondary';

                return (
                  <li key={file.path}>
                    <ButtonLink href={buildRunWorktreeHref(fixtureRun.id, file.path)} tone={tone}>
                      {file.changed ? `${file.path} *` : file.path}
                    </ButtonLink>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Panel title="Preview" description="Diff and content preview for selected file">
            <p className="meta-text">{selectedFile.path}</p>
            <p>{selectedFile.preview}</p>
            <pre className="code-preview" aria-label="File diff preview">
              {selectedFile.diff}
            </pre>
            <div className="action-row">
              <ButtonLink href={buildRunWorktreeHref(fixtureRun.id, selectedFile.path)} tone="primary">
                View Diff
              </ButtonLink>
              <ButtonLink href={`/runs/${fixtureRun.id}`}>Back to Run</ButtonLink>
            </div>
          </Panel>
        </div>
      </div>
    );
  }

  const parsedRunId = parseRunId(runId);
  if (parsedRunId === null) {
    notFound();
  }

  let detail: DashboardRunDetail;
  try {
    detail = await loadDashboardRunDetail(parsedRunId);
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
      notFound();
    }

    throw error;
  }

  const worktree = resolvePrimaryWorktree(detail);
  if (!worktree) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <h2>{`Run #${detail.run.id} worktree`}</h2>
          <p>Changed-file explorer scoped to this run.</p>
        </section>

        <Card title="No changed files" description="This run does not have a captured worktree.">
          <div className="action-row">
            <ButtonLink href={`/runs/${detail.run.id}`}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id} worktree`}</h2>
        <p>Persisted worktree metadata for this run.</p>
      </section>

      <div className="page-grid">
        <Card title="Worktree metadata" description="Resolved from persisted run detail.">
          <ul className="entity-list">
            <li>
              <span>Status</span>
              <span className="meta-text">{worktree.status}</span>
            </li>
            <li>
              <span>Branch</span>
              <span className="meta-text">{worktree.branch}</span>
            </li>
            <li>
              <span>Path</span>
              <span className="meta-text">{worktree.path}</span>
            </li>
            <li>
              <span>Commit</span>
              <span className="meta-text">{worktree.commitHash ?? 'Not captured'}</span>
            </li>
          </ul>
        </Card>

        <Panel title="File preview unavailable" description="Changed-file snapshots are only available for fixture-backed runs.">
          <p>Use run metadata and local filesystem tools to inspect this worktree.</p>
          <div className="action-row">
            <ButtonLink href={`/runs/${detail.run.id}`} tone="primary">Back to Run</ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}
