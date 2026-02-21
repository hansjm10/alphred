'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DashboardCreateWorkflowRequest, DashboardWorkflowTemplateKey } from '../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel } from '../../ui/primitives';

type ApiErrorEnvelope = {
  error?: {
    message?: string;
  };
};

function slugifyTreeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function resolveApiError(status: number, payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ApiErrorEnvelope).error === 'object' &&
    (payload as ApiErrorEnvelope).error !== null &&
    typeof (payload as ApiErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ApiErrorEnvelope).error?.message as string;
  }

  return `${fallback} (HTTP ${status}).`;
}

export function NewWorkflowPageContent() {
  const router = useRouter();
  const [template, setTemplate] = useState<DashboardWorkflowTemplateKey>('design-implement-review');
  const [name, setName] = useState('');
  const [treeKey, setTreeKey] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const suggestedTreeKey = useMemo(() => slugifyTreeKey(name), [name]);
  const effectiveTreeKey = treeKey.trim().length > 0 ? treeKey : suggestedTreeKey;

  const canSubmit = !creating && name.trim().length > 0 && effectiveTreeKey.length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;

    setError(null);
    setCreating(true);

    const payload: DashboardCreateWorkflowRequest = {
      template,
      name,
      treeKey: effectiveTreeKey,
      description: description.trim().length > 0 ? description : undefined,
    };

    try {
      const response = await fetch('/api/dashboard/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await response.json().catch(() => null);

      if (!response.ok) {
        setError(resolveApiError(response.status, json, 'Workflow creation failed'));
        return;
      }

      router.push(`/workflows/${encodeURIComponent(effectiveTreeKey)}/edit`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Workflow creation failed.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="page-stack">
      <Card
        title="Create workflow"
        description="Start from a template or build a blank workflow tree."
      >
        <div className="workflows-toolbar">
          <ButtonLink href="/workflows">Back to workflows</ButtonLink>
        </div>

        <div className="workflow-new-grid">
          <div className="workflow-new-section">
            <h2>Start point</h2>
            <div className="workflow-template-cards" role="radiogroup" aria-label="Workflow template">
              <label className={`workflow-template-card${template === 'design-implement-review' ? ' workflow-template-card--selected' : ''}`}>
                <input
                  type="radio"
                  name="workflow-template"
                  value="design-implement-review"
                  checked={template === 'design-implement-review'}
                  onChange={() => setTemplate('design-implement-review')}
                />
                <div>
                  <h3>Template: Design → Implement → Review</h3>
                  <p>Pre-wired phases with a revision loop based on routing decisions.</p>
                </div>
              </label>

              <label className={`workflow-template-card${template === 'blank' ? ' workflow-template-card--selected' : ''}`}>
                <input
                  type="radio"
                  name="workflow-template"
                  value="blank"
                  checked={template === 'blank'}
                  onChange={() => setTemplate('blank')}
                />
                <div>
                  <h3>Blank workflow</h3>
                  <p>Start with an empty canvas and add nodes/transitions from scratch.</p>
                </div>
              </label>
            </div>
          </div>

          <div className="workflow-new-section">
            <h2>Identity</h2>
            <div className="workflow-new-form">
              <label>
                <span>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Workflow name" />
              </label>

              <label>
                <span>Tree key</span>
                <input
                  value={treeKey}
                  onChange={(event) => setTreeKey(event.target.value)}
                  placeholder={suggestedTreeKey || 'tree-key'}
                />
                <span className="meta-text">Lowercase a-z, 0-9, hyphens. Unique across workflows.</span>
              </label>

              <label>
                <span>Description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional one-line description"
                  rows={3}
                />
              </label>

              {error ? (
                <p className="run-launch-banner--error" role="alert">{error}</p>
              ) : null}

              <div className="workflow-new-actions">
                <ActionButton tone="primary" onClick={handleSubmit} disabled={!canSubmit} aria-disabled={!canSubmit}>
                  {creating ? 'Creating...' : 'Create and open builder'}
                </ActionButton>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Panel title="Validation">
        <p className="meta-text">
          A workflow must be published before it can be launched from Runs. The builder will help you validate before publishing.
        </p>
      </Panel>
    </div>
  );
}
