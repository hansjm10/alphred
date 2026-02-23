'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DashboardCreateWorkflowRequest, DashboardWorkflowTemplateKey } from '../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel } from '../../ui/primitives';
import { resolveApiError, slugifyKey } from '../workflows-shared';

function slugifyTreeKey(value: string): string {
  return slugifyKey(value, 64);
}

function isTreeKeyFormatValid(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value);
}

type TreeKeyAvailability = 'idle' | 'checking' | 'available' | 'taken' | 'error';
type TreeKeyAvailabilityLookup = 'available' | 'taken';

type TreeKeyAvailabilityCheckResult =
  | {
      status: TreeKeyAvailabilityLookup;
    }
  | {
      status: 'error';
      message: string;
    }
  | {
      status: 'aborted';
    };

function parseTreeKeyAvailabilityPayload(payload: unknown): { treeKey: string; available: boolean } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (!('treeKey' in payload) || !('available' in payload)) {
    return null;
  }

  const treeKey = (payload as { treeKey?: unknown }).treeKey;
  const available = (payload as { available?: unknown }).available;
  if (typeof treeKey !== 'string' || typeof available !== 'boolean') {
    return null;
  }

  return { treeKey, available };
}

async function checkTreeKeyAvailability(
  effectiveTreeKey: string,
  signal: AbortSignal,
): Promise<TreeKeyAvailabilityCheckResult> {
  try {
    const response = await fetch(
      `/api/dashboard/workflows/catalog?treeKey=${encodeURIComponent(effectiveTreeKey)}`,
      {
        method: 'GET',
        signal,
      },
    );
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        status: 'error',
        message: resolveApiError(response.status, json, 'Tree key validation failed'),
      };
    }

    const parsed = parseTreeKeyAvailabilityPayload(json);
    if (parsed?.treeKey !== effectiveTreeKey) {
      return { status: 'error', message: 'Tree key validation failed.' };
    }

    return { status: parsed.available ? 'available' : 'taken' };
  } catch (error_) {
    if (error_ instanceof DOMException && error_.name === 'AbortError') {
      return { status: 'aborted' };
    }
    return {
      status: 'error',
      message: error_ instanceof Error ? error_.message : 'Tree key validation failed.',
    };
  }
}

async function createWorkflow(payload: DashboardCreateWorkflowRequest): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch('/api/dashboard/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        message: resolveApiError(response.status, json, 'Workflow creation failed'),
      };
    }

    return { ok: true };
  } catch (error_) {
    return {
      ok: false,
      message: error_ instanceof Error ? error_.message : 'Workflow creation failed.',
    };
  }
}

function TreeKeyValidationMessage({
  effectiveTreeKey,
  showTreeKeyValidation,
  treeKeyAvailability,
  treeKeyAvailabilityError,
  treeKeyValidationError,
}: Readonly<{
  effectiveTreeKey: string;
  showTreeKeyValidation: boolean;
  treeKeyAvailability: TreeKeyAvailability;
  treeKeyAvailabilityError: string | null;
  treeKeyValidationError: string | null;
}>) {
  if (!showTreeKeyValidation) {
    return <span className="meta-text">Lowercase a-z, 0-9, hyphens. Unique across workflows.</span>;
  }

  if (treeKeyValidationError) {
    return (
      <span className="workflow-field-validation workflow-field-validation--error" role="alert">
        {treeKeyValidationError}
      </span>
    );
  }

  switch (treeKeyAvailability) {
    case 'checking':
      return <span className="workflow-field-validation">Checking availability…</span>;
    case 'taken':
      return (
        <span className="workflow-field-validation workflow-field-validation--error" role="alert">
          Tree key &quot;{effectiveTreeKey}&quot; already exists.
        </span>
      );
    case 'error':
      return (
        <span className="workflow-field-validation workflow-field-validation--error" role="alert">
          {treeKeyAvailabilityError ?? 'Tree key validation failed.'}
        </span>
      );
    default:
      return (
        <span className="workflow-field-validation workflow-field-validation--success">
          Tree key is available.
        </span>
      );
  }
}

export function NewWorkflowPageContent() {
  const router = useRouter();
  const [template, setTemplate] = useState<DashboardWorkflowTemplateKey>('design-implement-review');
  const [name, setName] = useState('');
  const [treeKey, setTreeKey] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [treeKeyAvailability, setTreeKeyAvailability] = useState<TreeKeyAvailability>('idle');
  const [treeKeyAvailabilityError, setTreeKeyAvailabilityError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const suggestedTreeKey = useMemo(() => slugifyTreeKey(name), [name]);
  const effectiveTreeKey = (treeKey.trim().length > 0 ? treeKey : suggestedTreeKey).trim();
  const showTreeKeyValidation = name.trim().length > 0 || treeKey.trim().length > 0;
  const treeKeyValidationError = useMemo(() => {
    if (effectiveTreeKey.length === 0) {
      return 'Tree key is required.';
    }
    if (!isTreeKeyFormatValid(effectiveTreeKey)) {
      return 'Tree key must be lowercase and contain only a-z, 0-9, and hyphens.';
    }
    return null;
  }, [effectiveTreeKey]);

  useEffect(() => {
    if (!showTreeKeyValidation || treeKeyValidationError !== null) {
      setTreeKeyAvailability('idle');
      setTreeKeyAvailabilityError(null);
      return;
    }

    const abortController = new AbortController();
    setTreeKeyAvailability('checking');
    setTreeKeyAvailabilityError(null);

    checkTreeKeyAvailability(effectiveTreeKey, abortController.signal)
      .then((result) => {
        if (result.status === 'aborted') {
          return;
        }
        if (result.status === 'error') {
          setTreeKeyAvailability('error');
          setTreeKeyAvailabilityError(result.message);
          return;
        }
        setTreeKeyAvailability(result.status);
      })
      .catch(() => undefined);
    return () => abortController.abort();
  }, [effectiveTreeKey, showTreeKeyValidation, treeKeyValidationError]);

  const hasTreeKey = effectiveTreeKey.length > 0;
  const canSubmit =
    !creating &&
    name.trim().length > 0 &&
    hasTreeKey &&
    treeKeyValidationError === null &&
    treeKeyAvailability === 'available';

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
      const result = await createWorkflow(payload);
      if (!result.ok) {
        setError(result.message);
        return;
      }

      router.push(`/workflows/${encodeURIComponent(effectiveTreeKey)}/edit`);
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
              <label
                htmlFor="workflow-template-design-implement-review"
                aria-label="Template: Design implement review"
                className={`workflow-template-card${template === 'design-implement-review' ? ' workflow-template-card--selected' : ''}`}
              >
                <input
                  id="workflow-template-design-implement-review"
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

              <label
                htmlFor="workflow-template-blank"
                aria-label="Template: Blank workflow"
                className={`workflow-template-card${template === 'blank' ? ' workflow-template-card--selected' : ''}`}
              >
                <input
                  id="workflow-template-blank"
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
                <input
                  value={name}
                  onChange={(event) => {
                    setError(null);
                    setName(event.target.value);
                  }}
                  placeholder="Workflow name"
                />
              </label>

              <label>
                <span>Tree key</span>
                <input
                  value={treeKey}
                  onChange={(event) => {
                    setError(null);
                    setTreeKey(event.target.value);
                  }}
                  placeholder={suggestedTreeKey || 'tree-key'}
                />
                <TreeKeyValidationMessage
                  effectiveTreeKey={effectiveTreeKey}
                  showTreeKeyValidation={showTreeKeyValidation}
                  treeKeyAvailability={treeKeyAvailability}
                  treeKeyAvailabilityError={treeKeyAvailabilityError}
                  treeKeyValidationError={treeKeyValidationError}
                />
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
