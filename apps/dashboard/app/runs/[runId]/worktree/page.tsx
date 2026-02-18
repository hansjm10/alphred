import { notFound } from 'next/navigation';
import { buildRunWorktreeHref, findRunByParam, resolveWorktreePath } from '../../run-route-fixtures';
import { ButtonLink, Card, Panel } from '../../../ui/primitives';

type RunWorktreePageProps = Readonly<{
  params: {
    runId: string;
  };
  searchParams?: {
    path?: string | string[];
  };
}>;

export default function RunWorktreePage({ params, searchParams }: RunWorktreePageProps) {
  const run = findRunByParam(params.runId);
  if (run === null) {
    notFound();
  }

  if (run.worktree.files.length === 0) {
    return (
      <div className="page-stack">
        <section className="page-heading">
          <h2>{`Run #${run.id} worktree`}</h2>
          <p>Changed-file explorer scoped to this run.</p>
        </section>

        <Card title="No changed files" description="This run completed without file changes.">
          <div className="action-row">
            <ButtonLink href={`/runs/${run.id}`}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  const selectedPath = resolveWorktreePath(run, searchParams?.path);
  const fallbackFile = run.worktree.files[0];
  if (!fallbackFile) {
    notFound();
  }

  const selectedFile = run.worktree.files.find((file) => file.path === selectedPath) ?? fallbackFile;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${run.id} worktree`}</h2>
        <p>{`Branch ${run.worktree.branch} with ${run.worktree.files.length} tracked files.`}</p>
      </section>

      <div className="page-grid">
        <Card title="Changed files" description="Default selection is the first changed file.">
          <ul className="page-stack" aria-label="Worktree files">
            {run.worktree.files.map((file) => {
              const tone = file.path === selectedFile.path ? 'primary' : 'secondary';

              return (
                <li key={file.path}>
                  <ButtonLink href={buildRunWorktreeHref(run.id, file.path)} tone={tone}>
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
            <ButtonLink href={buildRunWorktreeHref(run.id, selectedFile.path)} tone="primary">
              View Diff
            </ButtonLink>
            <ButtonLink href={`/runs/${run.id}`}>Back to Run</ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}
