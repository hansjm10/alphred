import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { loadDashboardRunDetail } from '../../load-dashboard-runs';
import { buildRunWorktreeHref, findRunByParam, resolveWorktreePath } from '../../run-route-fixtures';
import { ButtonLink, Card, Panel } from '../../../ui/primitives';
import {
  loadPersistedRunWorktreeExplorer,
  type PersistedRunWorktreeExplorer,
  type PersistedRunWorktreeExplorerFile,
  type PersistedRunWorktreePreviewMode,
  type PersistedRunWorktreePreview,
} from './load-persisted-worktree-explorer';

type RunWorktreePageProps = Readonly<{
  params: Promise<{
    runId: string;
  }>;
  searchParams?: Promise<{
    path?: string | string[];
    view?: string | string[];
  }>;
}>;

type SearchParamValue = string | string[] | undefined;

type ExplorerPreviewMode = PersistedRunWorktreePreviewMode;

type ExplorerFile = PersistedRunWorktreeExplorerFile;

type ExplorerPreview = PersistedRunWorktreePreview;

type ExplorerViewModel = Readonly<{
  runId: number;
  branch: string;
  files: readonly ExplorerFile[];
  changedFileCount: number;
  selectedPath: string | null;
  preview: ExplorerPreview | null;
  previewError: string | null;
}>;

type FileTreeNode = {
  name: string;
  pathPrefix: string;
  changedFileCount: number;
  directories: Map<string, FileTreeNode>;
  files: ExplorerFile[];
};

function parseRunId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function resolvePrimaryWorktree(detail: DashboardRunDetail): DashboardRunDetail['worktrees'][number] | null {
  return (
    detail.worktrees.find((worktree) => worktree.status === 'active') ??
    detail.worktrees.at(-1) ??
    null
  );
}

function resolvePreviewMode(value: SearchParamValue): ExplorerPreviewMode {
  const resolved = Array.isArray(value) ? value[0] : value;
  if (resolved === 'content') {
    return 'content';
  }

  return 'diff';
}

function resolveRequestedPath(value: SearchParamValue): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  if (!resolved || resolved.length === 0) {
    return undefined;
  }

  return resolved;
}

function buildRunWorktreeViewHref(
  runId: number,
  path: string | undefined,
  mode: ExplorerPreviewMode,
): string {
  const href = buildRunWorktreeHref(runId, path);
  const separator = href.includes('?') ? '&' : '?';

  return `${href}${separator}view=${mode}`;
}

function createRootNode(): FileTreeNode {
  return {
    name: '',
    pathPrefix: '',
    changedFileCount: 0,
    directories: new Map(),
    files: [],
  };
}

function createDirectoryNode(
  name: string,
  pathPrefix: string,
  changed: boolean,
): FileTreeNode {
  return {
    name,
    pathPrefix,
    changedFileCount: changed ? 1 : 0,
    directories: new Map(),
    files: [],
  };
}

function appendFileToTree(root: FileTreeNode, file: ExplorerFile): void {
  const segments = file.path.split('/').filter((segment) => segment.length > 0);
  const fileName = segments.pop();
  if (!fileName) {
    return;
  }

  if (file.changed) {
    root.changedFileCount += 1;
  }

  let currentNode = root;
  let currentPrefix = '';

  for (const segment of segments) {
    currentPrefix = currentPrefix.length > 0 ? `${currentPrefix}/${segment}` : segment;
    const existing = currentNode.directories.get(segment);
    if (existing) {
      if (file.changed) {
        existing.changedFileCount += 1;
      }
      currentNode = existing;
      continue;
    }

    const created = createDirectoryNode(segment, currentPrefix, file.changed);
    currentNode.directories.set(segment, created);
    currentNode = created;
  }

  currentNode.files.push(file);
}

function buildFileTree(files: readonly ExplorerFile[]): FileTreeNode {
  const root = createRootNode();

  for (const file of files) {
    appendFileToTree(root, file);
  }

  return root;
}

function renderTreeChildren(
  node: FileTreeNode,
  runId: number,
  selectedPath: string | null,
  previewMode: ExplorerPreviewMode,
): ReactNode {
  const sortedDirectories = [...node.directories.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const sortedFiles = [...node.files].sort((left, right) => left.path.localeCompare(right.path));

  return (
    <ul className="worktree-tree-list">
      {sortedDirectories.map((directory) => {
        const openByDefault =
          selectedPath !== null &&
          (selectedPath === directory.pathPrefix || selectedPath.startsWith(`${directory.pathPrefix}/`));

        return (
          <li key={`dir:${directory.pathPrefix}`} className="worktree-tree-directory-item">
            <details className="worktree-tree-directory" open={openByDefault}>
              <summary>
                <span className="worktree-tree-directory-name">{directory.name}</span>
                <span className="meta-text">{`${directory.changedFileCount} changed`}</span>
              </summary>
              {renderTreeChildren(directory, runId, selectedPath, previewMode)}
            </details>
          </li>
        );
      })}

      {sortedFiles.map((file) => {
        const fileName = file.path.split('/').at(-1) ?? file.path;
        const selected = selectedPath === file.path;

        return (
          <li
            key={`file:${file.path}`}
            className={file.changed ? 'worktree-tree-file-item worktree-tree-file-item--changed' : 'worktree-tree-file-item'}
          >
            <ButtonLink
              href={
                previewMode === 'content'
                  ? buildRunWorktreeViewHref(runId, file.path, previewMode)
                  : buildRunWorktreeHref(runId, file.path)
              }
              tone={selected ? 'primary' : 'secondary'}
              aria-current={selected ? 'page' : undefined}
              aria-label={`Open ${file.path} preview`}
            >
              {fileName}
            </ButtonLink>
            <div className="worktree-tree-file-meta">
              {file.changed ? (
                <span className="worktree-change-badge" aria-label={`${file.path} changed`}>
                  Changed
                </span>
              ) : null}
              <span className="meta-text">{file.path}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function renderPreviewBody(
  runId: number,
  previewMode: ExplorerPreviewMode,
  selectedPath: string | null,
  preview: ExplorerPreview | null,
  previewError: string | null,
): ReactNode {
  if (previewError) {
    return (
      <div className="page-stack">
        <p>{previewError}</p>
        <div className="action-row">
          <ButtonLink href={buildRunWorktreeViewHref(runId, selectedPath ?? undefined, previewMode)} tone="primary">
            Retry Path
          </ButtonLink>
        </div>
      </div>
    );
  }

  if (!preview) {
    return <p>Select a file to inspect this worktree snapshot.</p>;
  }

  const showDiff = previewMode === 'diff';
  const showContent = previewMode === 'content';

  return (
    <div className="page-stack">
      <p className="meta-text">{preview.path}</p>
      <div className="action-row">
        <ButtonLink
          href={buildRunWorktreeViewHref(runId, preview.path, 'diff')}
          tone={showDiff ? 'primary' : 'secondary'}
        >
          View Diff
        </ButtonLink>
        <ButtonLink
          href={buildRunWorktreeViewHref(runId, preview.path, 'content')}
          tone={showContent ? 'primary' : 'secondary'}
        >
          {preview.binary ? 'Open Raw' : 'View Content'}
        </ButtonLink>
      </div>

      {showDiff ? (
        <section className="worktree-preview-section">
          <h4>Diff summary</h4>
          {preview.diff ? (
            <pre className="code-preview" aria-label="File diff preview">
              {preview.diff}
            </pre>
          ) : (
            <p>{preview.diffMessage ?? 'No diff summary is available for this file.'}</p>
          )}
        </section>
      ) : null}

      {showContent ? (
        <section className="worktree-preview-section">
          <h4>File content</h4>
          {preview.content === null ? (
            <p>{preview.contentMessage ?? 'No content preview is available for this file.'}</p>
          ) : (
            <pre className="code-preview" aria-label="File content preview">
              {preview.content}
            </pre>
          )}
        </section>
      ) : null}
    </div>
  );
}

function renderWorktreeExplorer(model: ExplorerViewModel, previewMode: ExplorerPreviewMode): ReactNode {
  const fileTree = buildFileTree(model.files);

  return (
    <div className="worktree-layout">
      <section className="page-heading">
        <h2>{`Run #${model.runId} worktree`}</h2>
        <p>{`Branch ${model.branch} with ${model.changedFileCount} changed file${model.changedFileCount === 1 ? '' : 's'} across ${model.files.length} paths.`}</p>
      </section>

      <Card tone="subtle" title="Run context" description="Run-linked file snapshot for this worktree.">
        <ul className="entity-list">
          <li>
            <span>Branch</span>
            <span className="meta-text">{model.branch}</span>
          </li>
          <li>
            <span>Changed files</span>
            <span className="meta-text">{model.changedFileCount}</span>
          </li>
          <li>
            <span>Selected path</span>
            <span className="meta-text">{model.selectedPath ?? 'None selected'}</span>
          </li>
        </ul>
      </Card>

      <div className="worktree-grid">
        <Card title="Changed files" description="Default selection prioritizes changed files before tracked-file fallback.">
          {renderTreeChildren(fileTree, model.runId, model.selectedPath, previewMode)}
        </Card>

        <Panel title="Preview" description="Toggle between diff and content previews for the selected file.">
          {renderPreviewBody(
            model.runId,
            previewMode,
            model.selectedPath,
            model.preview,
            model.previewError,
          )}
          <div className="action-row">
            <ButtonLink href={`/runs/${model.runId}`}>Back to Run</ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}

async function renderFixtureWorktreePage(
  runIdParam: string,
  searchPath: SearchParamValue,
  previewMode: ExplorerPreviewMode,
): Promise<ReactNode> {
  const fixtureRun = findRunByParam(runIdParam);
  if (fixtureRun === null) {
    notFound();
  }

  if (fixtureRun.worktree.files.length === 0) {
    return (
      <div className="worktree-layout">
        <section className="page-heading">
          <h2>{`Run #${fixtureRun.id} worktree`}</h2>
          <p>Changed-file explorer scoped to this run.</p>
        </section>

        <Card title="No changed files" description="No tracked files were captured for this fixture run.">
          <div className="action-row">
            <ButtonLink href={`/runs/${fixtureRun.id}`}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  const changedFileCount = fixtureRun.worktree.files.filter((file) => file.changed).length;
  const selectedPath = resolveWorktreePath(fixtureRun, searchPath);
  const selectedFile = fixtureRun.worktree.files.find((file) => file.path === selectedPath) ?? null;

  return renderWorktreeExplorer(
    {
      runId: fixtureRun.id,
      branch: fixtureRun.worktree.branch,
      files: fixtureRun.worktree.files.map((file) => ({
        path: file.path,
        changed: file.changed,
      })),
      changedFileCount,
      selectedPath,
      preview: selectedFile
        ? {
            path: selectedFile.path,
            changed: selectedFile.changed,
            diff: selectedFile.diff,
            diffMessage: selectedFile.changed
              ? null
              : 'No diff is available because this file is unchanged in the fixture snapshot.',
            content: selectedFile.preview,
            contentMessage: null,
            binary: false,
          }
        : null,
      previewError: null,
    },
    previewMode,
  );
}

async function renderPersistedWorktreePage(
  detail: DashboardRunDetail,
  searchPath: SearchParamValue,
  previewMode: ExplorerPreviewMode,
): Promise<ReactNode> {
  const worktree = resolvePrimaryWorktree(detail);
  if (!worktree) {
    return (
      <div className="worktree-layout">
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

  let explorer: PersistedRunWorktreeExplorer;
  try {
    explorer = await loadPersistedRunWorktreeExplorer(worktree.path, searchPath, previewMode);
  } catch {
    return (
      <div className="worktree-layout">
        <section className="page-heading">
          <h2>{`Run #${detail.run.id} worktree`}</h2>
          <p>{`Branch ${worktree.branch}`}</p>
        </section>

        <Card
          title="Unable to load worktree files"
          description="The explorer could not load this worktree snapshot. Retry this path-scoped request."
        >
          <div className="action-row">
            <ButtonLink
              href={buildRunWorktreeViewHref(detail.run.id, resolveRequestedPath(searchPath), previewMode)}
              tone="primary"
            >
              Retry Path
            </ButtonLink>
            <ButtonLink href={`/runs/${detail.run.id}`}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  if (explorer.files.length === 0) {
    return (
      <div className="worktree-layout">
        <section className="page-heading">
          <h2>{`Run #${detail.run.id} worktree`}</h2>
          <p>{`Branch ${worktree.branch}`}</p>
        </section>

        <Card title="No changed files" description="No tracked or changed files were detected in this worktree snapshot.">
          <div className="action-row">
            <ButtonLink href={`/runs/${detail.run.id}`}>Back to Run</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return renderWorktreeExplorer(
    {
      runId: detail.run.id,
      branch: worktree.branch,
      files: explorer.files,
      changedFileCount: explorer.changedFileCount,
      selectedPath: explorer.selectedPath,
      preview: explorer.preview,
      previewError: explorer.previewError,
    },
    previewMode,
  );
}

export default async function RunWorktreePage({ params, searchParams }: RunWorktreePageProps) {
  const { runId } = await params;
  const resolvedSearchParams = await searchParams;
  const parsedRunId = parseRunId(runId);
  if (parsedRunId === null) {
    notFound();
  }

  const previewMode = resolvePreviewMode(resolvedSearchParams?.view);

  let detail: DashboardRunDetail | null = null;
  try {
    detail = await loadDashboardRunDetail(parsedRunId);
  } catch (error) {
    if (!(error instanceof DashboardIntegrationError && error.code === 'not_found')) {
      throw error;
    }
  }

  if (detail === null) {
    return renderFixtureWorktreePage(runId, resolvedSearchParams?.path, previewMode);
  }

  return renderPersistedWorktreePage(detail, resolvedSearchParams?.path, previewMode);
}
