'use client';

import type { ChangeEvent } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type {
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { Panel } from '../../../ui/primitives';

function readGuardDecisionValue(expression: unknown): string {
  if (!expression || typeof expression !== 'object') {
    return 'approved';
  }

  if (!('value' in expression)) {
    return 'approved';
  }

  const value = (expression as { value?: unknown }).value;
  return typeof value === 'string' ? value : 'approved';
}

export function NodeInspector({
  node,
  onChange,
}: Readonly<{
  node: Node | null;
  onChange: (next: DashboardWorkflowDraftNode) => void;
}>) {
  if (!node) {
    return <p className="meta-text">Select a node to edit details.</p>;
  }

  const data = node.data as DashboardWorkflowDraftNode;

  function handleFieldChange<K extends keyof DashboardWorkflowDraftNode>(field: K, value: DashboardWorkflowDraftNode[K]) {
    onChange({ ...data, [field]: value });
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!data.promptTemplate) {
      handleFieldChange('promptTemplate', { content: event.target.value, contentType: 'markdown' });
      return;
    }

    handleFieldChange('promptTemplate', { ...data.promptTemplate, content: event.target.value });
  }

  const nodeType = data.nodeType;
  const isAgent = nodeType === 'agent';

  return (
    <div className="workflow-inspector-stack">
      <h3>Node</h3>
      <label className="workflow-inspector-field">
        <span>Display name</span>
        <input value={data.displayName} onChange={(event) => handleFieldChange('displayName', event.target.value)} />
      </label>

      <label className="workflow-inspector-field">
        <span>Node key</span>
        <input value={data.nodeKey} disabled aria-disabled="true" />
        <span className="meta-text">Node keys are generated automatically in the draft builder.</span>
      </label>

      <label className="workflow-inspector-field">
        <span>Node type</span>
        <select value={data.nodeType} onChange={(event) => handleFieldChange('nodeType', event.target.value as DashboardWorkflowDraftNode['nodeType'])}>
          <option value="agent">agent</option>
          <option value="human">human</option>
          <option value="tool">tool</option>
        </select>
      </label>

      {isAgent ? (
        <label className="workflow-inspector-field">
          <span>Provider</span>
          <input value={data.provider ?? ''} onChange={(event) => handleFieldChange('provider', event.target.value)} />
          <span className="meta-text">Provider selection will be configurable once multiple backends are supported.</span>
        </label>
      ) : (
        <p className="meta-text">Human/tool nodes are supported as draft placeholders; publishing may be blocked by validation.</p>
      )}

      {isAgent ? (
        <label className="workflow-inspector-field">
          <span>Prompt template</span>
          <textarea rows={8} value={data.promptTemplate?.content ?? ''} onChange={handlePromptChange} />
        </label>
      ) : null}

      <label className="workflow-inspector-field">
        <span>Max retries</span>
        <input
          type="number"
          min={0}
          value={data.maxRetries}
          onChange={(event) => handleFieldChange('maxRetries', Number(event.target.value))}
        />
      </label>
    </div>
  );
}

export function EdgeInspector({
  edge,
  onChange,
}: Readonly<{
  edge: Edge | null;
  onChange: (next: DashboardWorkflowDraftEdge) => void;
}>) {
  if (!edge) {
    return <p className="meta-text">Select a transition to edit details.</p>;
  }

  const data = edge.data as DashboardWorkflowDraftEdge;

  function handleAutoChange(nextAuto: boolean) {
    if (nextAuto) {
      onChange({ ...data, auto: true, guardExpression: null });
      return;
    }

    onChange({
      ...data,
      auto: false,
      guardExpression: data.guardExpression ?? { field: 'decision', operator: '==', value: 'approved' },
    });
  }

  function handleGuardValueChange(nextValue: string) {
    onChange({
      ...data,
      auto: false,
      guardExpression: { field: 'decision', operator: '==', value: nextValue },
    });
  }

  return (
    <div className="workflow-inspector-stack">
      <h3>Transition</h3>
      <p className="meta-text">{edge.source} → {edge.target}</p>

      <label className="workflow-inspector-field">
        <span>Priority</span>
        <input
          type="number"
          min={0}
          value={data.priority}
          onChange={(event) => onChange({ ...data, priority: Number(event.target.value) })}
        />
      </label>

      <label className="workflow-inspector-field workflow-inspector-field--inline">
        <span>Auto</span>
        <input type="checkbox" checked={data.auto} onChange={(event) => handleAutoChange(event.target.checked)} />
      </label>

      {!data.auto ? (
        <label className="workflow-inspector-field">
          <span>Guard (decision)</span>
          <select
            value={readGuardDecisionValue(data.guardExpression)}
            onChange={(event) => handleGuardValueChange(event.target.value)}
          >
            <option value="approved">approved</option>
            <option value="changes_requested">changes_requested</option>
            <option value="blocked">blocked</option>
            <option value="retry">retry</option>
          </select>
        </label>
      ) : (
        <p className="meta-text">Auto transitions are unconditional.</p>
      )}
    </div>
  );
}

export function WorkflowInspector({
  name,
  description,
  versionNotes,
  onNameChange,
  onDescriptionChange,
  onVersionNotesChange,
  initialRunnableNodeKeys,
  validation,
  validationError,
  publishError,
}: Readonly<{
  name: string;
  description: string;
  versionNotes: string;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onVersionNotesChange: (next: string) => void;
  initialRunnableNodeKeys: readonly string[];
  validation: DashboardWorkflowValidationResult | null;
  validationError: string | null;
  publishError: string | null;
}>) {
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];

  return (
    <div className="workflow-inspector-stack">
      <h3>Workflow</h3>
      <label className="workflow-inspector-field">
        <span>Name</span>
        <input value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>

      <label className="workflow-inspector-field">
        <span>Description</span>
        <textarea rows={3} value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
      </label>

      <label className="workflow-inspector-field">
        <span>Version notes</span>
        <textarea rows={3} value={versionNotes} onChange={(event) => onVersionNotesChange(event.target.value)} />
        <span className="meta-text">Optional notes to attach to this version when publishing.</span>
      </label>

      <Panel title="Initial runnable nodes">
        {initialRunnableNodeKeys.length === 0 ? (
          <p className="meta-text">None detected.</p>
        ) : (
          <div className="workflow-chip-row">
            {initialRunnableNodeKeys.map((key) => (
              <span key={key} className="workflow-chip">{key}</span>
            ))}
          </div>
        )}
      </Panel>

      {validationError ? <p className="run-launch-banner--error" role="alert">{validationError}</p> : null}
      {publishError ? <p className="run-launch-banner--error" role="alert">{publishError}</p> : null}

      <Panel title="Validation results">
        {validation === null ? (
          <p className="meta-text">Run validation to see publish blockers and warnings.</p>
        ) : errors.length === 0 && warnings.length === 0 ? (
          <p className="meta-text">No issues detected.</p>
        ) : (
          <div className="workflow-validation-stack">
            {errors.length > 0 ? (
              <div>
                <h4>Errors</h4>
                <ul className="workflow-issue-list">
                  {errors.map((issue) => (
                    <li key={`error-${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div>
                <h4>Warnings</h4>
                <ul className="workflow-issue-list">
                  {warnings.map((issue) => (
                    <li key={`warn-${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

