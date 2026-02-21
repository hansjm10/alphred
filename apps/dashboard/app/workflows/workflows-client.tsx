'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { DashboardWorkflowCatalogItem } from '../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel } from '../ui/primitives';
import { resolveApiError, slugifyKey } from './workflows-shared';

type WorkflowsPageContentProps = Readonly<{
  workflows: readonly DashboardWorkflowCatalogItem[];
}>;

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  const deltaMs = Date.now() - date.getTime();
  if (!Number.isFinite(deltaMs)) {
    return 'Unknown';
  }

  const deltaSeconds = Math.floor(deltaMs / 1000);
  if (deltaSeconds < 30) return 'just now';
  if (deltaSeconds < 90) return '1m ago';
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function renderVersionCell(workflow: DashboardWorkflowCatalogItem): ReactNode {
  if (workflow.draftVersion !== null) {
    const published = workflow.publishedVersion === null ? '—' : `v${workflow.publishedVersion}`;
    return (
      <div className="workflow-version-cell">
        <span className="workflow-draft-pill">Draft v{workflow.draftVersion}</span>
        <span className="meta-text">Published {published}</span>
      </div>
    );
  }

  if (workflow.publishedVersion !== null) {
    return <span>v{workflow.publishedVersion}</span>;
  }

  return <span className="meta-text">—</span>;
}

type DuplicateDialogState = {
  open: boolean;
  sourceTreeKey: string;
  sourceName: string;
  name: string;
  treeKey: string;
  description: string;
  submitting: boolean;
  error: string | null;
};

function slugifyTreeKey(value: string): string {
  return slugifyKey(value, 64);
}

export function WorkflowsPageContent({ workflows }: WorkflowsPageContentProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [duplicateDialog, setDuplicateDialog] = useState<DuplicateDialogState | null>(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredWorkflows = useMemo(() => {
    if (normalizedQuery.length === 0) return workflows;

    return workflows.filter((workflow) => {
      return (
        workflow.name.toLowerCase().includes(normalizedQuery) ||
        workflow.treeKey.toLowerCase().includes(normalizedQuery) ||
        (workflow.description ?? '').toLowerCase().includes(normalizedQuery)
      );
    });
  }, [normalizedQuery, workflows]);

  const hasWorkflows = workflows.length > 0;

  async function submitDuplicate(event: FormEvent) {
    event.preventDefault();
    if (!duplicateDialog || duplicateDialog.submitting) return;

    const name = duplicateDialog.name.trim();
    const treeKey = duplicateDialog.treeKey.trim().length > 0 ? duplicateDialog.treeKey.trim() : slugifyTreeKey(name);
    if (name.length === 0 || treeKey.length === 0) {
      setDuplicateDialog(current =>
        current
          ? {
              ...current,
              error: 'Name and tree key are required.',
            }
          : current,
      );
      return;
    }

    setDuplicateDialog(current => (current ? { ...current, submitting: true, error: null } : current));

    try {
      const response = await fetch(
        `/api/dashboard/workflows/${encodeURIComponent(duplicateDialog.sourceTreeKey)}/duplicate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            treeKey,
            description: duplicateDialog.description.trim().length > 0 ? duplicateDialog.description : undefined,
          }),
        },
      );

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setDuplicateDialog(current =>
          current
            ? {
                ...current,
                submitting: false,
                error: resolveApiError(response.status, json, 'Workflow duplicate failed'),
              }
            : current,
        );
        return;
      }

      setDuplicateDialog(null);
      router.push(`/workflows/${encodeURIComponent(treeKey)}/edit`);
    } catch (failure) {
      setDuplicateDialog(current =>
        current
          ? {
              ...current,
              submitting: false,
              error: failure instanceof Error ? failure.message : 'Workflow duplicate failed.',
            }
          : current,
      );
    }
  }

  return (
    <div className="page-stack">
      <Card
        title="Workflow trees"
        description="Create and publish versioned workflow graphs without touching code."
      >
        <div className="workflows-toolbar">
          <ButtonLink href="/workflows/new" tone="primary">
            Create workflow
          </ButtonLink>
        </div>

        <div className="repositories-search">
          <label htmlFor="workflow-search">Search</label>
          <input
            id="workflow-search"
            value={searchQuery}
            placeholder="Filter by name, key, or description..."
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>

        {!hasWorkflows ? (
          <div className="empty-state">
            <h2>No workflows yet</h2>
            <p>Create your first workflow tree to start launching runs.</p>
            <ButtonLink href="/workflows/new" tone="primary">Create workflow</ButtonLink>
          </div>
        ) : (
          <div className="workflows-table-wrapper">
            <table className="workflows-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Tree key</th>
                  <th>Latest</th>
                  <th>Description</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredWorkflows.map((workflow) => {
                  const editHref = `/workflows/${encodeURIComponent(workflow.treeKey)}/edit`;
                  const viewHref = `/workflows/${encodeURIComponent(workflow.treeKey)}`;

                  return (
                    <tr key={workflow.treeKey}>
                      <td className="workflow-name-cell">{workflow.name}</td>
                      <td><code className="repo-path">{workflow.treeKey}</code></td>
                      <td>{renderVersionCell(workflow)}</td>
                      <td className="workflow-desc-cell">{workflow.description ?? <span className="meta-text">—</span>}</td>
                      <td><span className="meta-text">{formatRelativeTime(workflow.updatedAt)}</span></td>
                      <td>
                        <div className="workflow-actions">
                          <ButtonLink href={editHref}>Edit</ButtonLink>
                          <ActionButton
                            onClick={() => {
                              const suggestedName = `${workflow.name} copy`;
                              const suggestedKey = slugifyTreeKey(`${workflow.treeKey}-copy`) || `${workflow.treeKey}-copy`;
                              setDuplicateDialog({
                                open: true,
                                sourceTreeKey: workflow.treeKey,
                                sourceName: workflow.name,
                                name: suggestedName,
                                treeKey: suggestedKey,
                                description: workflow.description ?? '',
                                submitting: false,
                                error: null,
                              });
                            }}
                          >
                            Duplicate
                          </ActionButton>
                          <ButtonLink href={viewHref}>View JSON</ButtonLink>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Panel title="Notes">
        <ul className="meta-list">
          <li>Runs can only launch published workflow versions.</li>
          <li>Edit always works against a draft of the next version.</li>
        </ul>
      </Panel>

      {duplicateDialog?.open ? (
        <div
          className="workflow-overlay"
          role="presentation"
          onMouseDown={() => setDuplicateDialog(null)}
        >
          <div
            className="workflow-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Duplicate workflow"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="workflow-dialog__header">
              <h3>Duplicate workflow</h3>
              <p className="meta-text">Creates a new draft v1 from “{duplicateDialog.sourceName}”.</p>
            </header>

            <form className="workflow-dialog__form" onSubmit={submitDuplicate}>
              <label className="workflow-dialog__field">
                <span>Name</span>
                <input
                  value={duplicateDialog.name}
                  onChange={(event) =>
                    setDuplicateDialog((current) => (current ? { ...current, name: event.target.value } : current))
                  }
                  placeholder="Workflow name"
                  autoFocus
                />
              </label>

              <label className="workflow-dialog__field">
                <span>Tree key</span>
                <input
                  value={duplicateDialog.treeKey}
                  onChange={(event) =>
                    setDuplicateDialog((current) => (current ? { ...current, treeKey: event.target.value } : current))
                  }
                  placeholder={slugifyTreeKey(duplicateDialog.name) || 'tree-key'}
                />
                <span className="meta-text">Lowercase a-z, 0-9, hyphens. Unique across workflows.</span>
              </label>

              <label className="workflow-dialog__field">
                <span>Description</span>
                <textarea
                  value={duplicateDialog.description}
                  onChange={(event) =>
                    setDuplicateDialog((current) => (current ? { ...current, description: event.target.value } : current))
                  }
                  placeholder="Optional one-line description"
                  rows={3}
                />
              </label>

              {duplicateDialog.error ? (
                <p className="run-launch-banner--error" role="alert">{duplicateDialog.error}</p>
              ) : null}

              <div className="workflow-dialog__actions">
                <ActionButton onClick={() => setDuplicateDialog(null)} disabled={duplicateDialog.submitting}>
                  Cancel
                </ActionButton>
                <ActionButton tone="primary" type="submit" disabled={duplicateDialog.submitting}>
                  {duplicateDialog.submitting ? 'Duplicating...' : 'Duplicate and open builder'}
                </ActionButton>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
