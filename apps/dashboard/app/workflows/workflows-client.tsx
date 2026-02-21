'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { DashboardWorkflowCatalogItem } from '../../src/server/dashboard-contracts';
import { ButtonLink, Card, Panel } from '../ui/primitives';

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

export function WorkflowsPageContent({ workflows }: WorkflowsPageContentProps) {
  const [searchQuery, setSearchQuery] = useState('');
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
                          <ButtonLink href={viewHref}>View</ButtonLink>
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
    </div>
  );
}
