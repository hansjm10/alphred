'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { GuardCondition, GuardExpression, GuardOperator } from '@alphred/shared';
import type { Edge, Node } from '@xyflow/react';
import type {
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowValidationIssue,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { ActionButton, Panel } from '../../../ui/primitives';

const guardOperators: readonly GuardOperator[] = ['==', '!=', '>', '<', '>=', '<='];

type GuardEditorMode = 'guided' | 'advanced';

type GuidedConditionDraft = {
  field: string;
  operator: GuardOperator;
  value: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGuardExpression(value: unknown): value is GuardExpression {
  if (!isRecord(value)) {
    return false;
  }

  if ('logic' in value) {
    if ((value.logic !== 'and' && value.logic !== 'or') || !Array.isArray(value.conditions)) {
      return false;
    }

    return value.conditions.every(isGuardExpression);
  }

  if (!('field' in value) || !('operator' in value) || !('value' in value)) {
    return false;
  }

  if (typeof value.field !== 'string') {
    return false;
  }

  if (typeof value.operator !== 'string' || !guardOperators.includes(value.operator as GuardOperator)) {
    return false;
  }

  return ['string', 'number', 'boolean'].includes(typeof value.value);
}

function parseGuardValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return value;
}

function toGuidedCondition(condition: GuardCondition): GuidedConditionDraft {
  return {
    field: condition.field,
    operator: condition.operator,
    value: String(condition.value),
  };
}

function toGuidedState(expression: GuardExpression | null): {
  logic: 'and' | 'or';
  conditions: GuidedConditionDraft[];
} {
  if (!expression) {
    return {
      logic: 'and',
      conditions: [{ field: 'decision', operator: '==', value: 'approved' }],
    };
  }

  if ('logic' in expression) {
    const flatConditions = expression.conditions.filter((condition): condition is GuardCondition => {
      return !('logic' in condition);
    });

    if (flatConditions.length > 0) {
      return {
        logic: expression.logic,
        conditions: flatConditions.map(toGuidedCondition),
      };
    }
  }

  if (!('logic' in expression)) {
    return {
      logic: 'and',
      conditions: [toGuidedCondition(expression)],
    };
  }

  return {
    logic: 'and',
    conditions: [{ field: 'decision', operator: '==', value: 'approved' }],
  };
}

function toGuardExpression(logic: 'and' | 'or', conditions: GuidedConditionDraft[]): GuardExpression {
  const normalized = conditions.map((condition): GuardCondition => {
    return {
      field: condition.field.trim(),
      operator: condition.operator,
      value: parseGuardValue(condition.value),
    };
  });

  if (normalized.length === 1) {
    return normalized[0];
  }

  return {
    logic,
    conditions: normalized,
  };
}

function summarizeGuardExpression(expression: GuardExpression | null): string {
  if (!expression) {
    return 'decision == approved';
  }

  if ('logic' in expression) {
    return `${expression.logic.toUpperCase()} group (${expression.conditions.length} conditions)`;
  }

  return `${expression.field} ${expression.operator} ${String(expression.value)}`;
}

export function NodeInspector({
  node,
  onChange,
  onAddConnectedNode,
}: Readonly<{
  node: Node | null;
  onChange: (next: DashboardWorkflowDraftNode) => void;
  onAddConnectedNode?: (nodeKey: string) => void;
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

      {onAddConnectedNode ? (
        <div className="workflow-inspector-actions">
          <ActionButton onClick={() => onAddConnectedNode(data.nodeKey)}>Add connected node</ActionButton>
        </div>
      ) : null}
    </div>
  );
}

function EdgeInspectorContent({
  edge,
  data,
  onChange,
}: Readonly<{
  edge: Edge;
  data: DashboardWorkflowDraftEdge;
  onChange: (next: DashboardWorkflowDraftEdge) => void;
}>) {
  const [mode, setMode] = useState<GuardEditorMode>('guided');
  const [guidedLogic, setGuidedLogic] = useState<'and' | 'or'>('and');
  const [guidedConditions, setGuidedConditions] = useState<GuidedConditionDraft[]>([
    { field: 'decision', operator: '==', value: 'approved' },
  ]);
  const [advancedExpression, setAdvancedExpression] = useState('');
  const [advancedError, setAdvancedError] = useState<string | null>(null);

  useEffect(() => {
    const guided = toGuidedState(data.auto ? null : data.guardExpression);
    setGuidedLogic(guided.logic);
    setGuidedConditions(guided.conditions);
    setAdvancedExpression(JSON.stringify(data.auto ? { field: 'decision', operator: '==', value: 'approved' } : data.guardExpression, null, 2));
    setAdvancedError(null);
  }, [data.auto, data.guardExpression]);

  const guardSummary = useMemo(() => {
    return summarizeGuardExpression(data.auto ? null : data.guardExpression);
  }, [data.auto, data.guardExpression]);

  function handleAutoChange(nextAuto: boolean) {
    if (nextAuto) {
      onChange({ ...data, auto: true, guardExpression: null });
      return;
    }

    const fallback = data.guardExpression ?? { field: 'decision', operator: '==', value: 'approved' };
    onChange({
      ...data,
      auto: false,
      guardExpression: fallback,
    });
  }

  function applyGuidedState(nextLogic: 'and' | 'or', nextConditions: GuidedConditionDraft[]) {
    setGuidedLogic(nextLogic);
    setGuidedConditions(nextConditions);
    onChange({
      ...data,
      auto: false,
      guardExpression: toGuardExpression(nextLogic, nextConditions),
    });
  }

  function handleGuidedConditionChange(index: number, patch: Partial<GuidedConditionDraft>) {
    const nextConditions = guidedConditions.map((condition, conditionIndex) => {
      return conditionIndex === index ? { ...condition, ...patch } : condition;
    });

    applyGuidedState(guidedLogic, nextConditions);
  }

  function addGuidedCondition() {
    const nextConditions: GuidedConditionDraft[] = [
      ...guidedConditions,
      { field: 'decision', operator: '==', value: 'approved' },
    ];
    applyGuidedState(guidedLogic, nextConditions);
  }

  function removeGuidedCondition(index: number) {
    if (guidedConditions.length <= 1) {
      return;
    }

    const nextConditions = guidedConditions.filter((_, conditionIndex) => conditionIndex !== index);
    applyGuidedState(guidedLogic, nextConditions);
  }

  function handleAdvancedChange(nextRaw: string) {
    setAdvancedExpression(nextRaw);

    try {
      const parsed = JSON.parse(nextRaw) as unknown;
      if (!isGuardExpression(parsed)) {
        setAdvancedError('Guard expression must be a valid condition or logical group JSON object.');
        return;
      }

      setAdvancedError(null);
      onChange({
        ...data,
        auto: false,
        guardExpression: parsed,
      });
    } catch (error_) {
      setAdvancedError(error_ instanceof Error ? error_.message : 'Guard expression JSON is invalid.');
    }
  }

  return (
    <div className="workflow-inspector-stack">
      <h3>Transition</h3>
      <p className="meta-text">{edge.source} → {edge.target}</p>
      <p className="meta-text">Transitions are evaluated by priority; first match wins.</p>

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

      {data.auto ? (
        <p className="meta-text">Auto transitions are unconditional.</p>
      ) : (
        <>
          <div className="workflow-inspector-field">
            <span>Guard mode</span>
            <div className="workflow-segmented-control" role="group" aria-label="Guard editor mode">
              <button
                type="button"
                className={mode === 'guided' ? 'active' : ''}
                onClick={() => setMode('guided')}
              >
                Guided
              </button>
              <button
                type="button"
                className={mode === 'advanced' ? 'active' : ''}
                onClick={() => setMode('advanced')}
              >
                Advanced
              </button>
            </div>
            <span className="meta-text">Current guard: {guardSummary}</span>
          </div>

          {mode === 'guided' ? (
            <div className="workflow-inspector-field">
              <span>Guided guard builder</span>
              <label className="workflow-inspector-field">
                <span>Group logic</span>
                <select
                  value={guidedLogic}
                  onChange={(event) => applyGuidedState(event.target.value as 'and' | 'or', guidedConditions)}
                >
                  <option value="and">and</option>
                  <option value="or">or</option>
                </select>
              </label>

              <ul className="workflow-guard-condition-list">
                {guidedConditions.map((condition, index) => (
                  <li key={`condition-${index}`} className="workflow-guard-condition-row">
                    <input
                      aria-label={`Guard field ${index + 1}`}
                      value={condition.field}
                      onChange={(event) => handleGuidedConditionChange(index, { field: event.target.value })}
                      placeholder="field"
                    />
                    <select
                      aria-label={`Guard operator ${index + 1}`}
                      value={condition.operator}
                      onChange={(event) => handleGuidedConditionChange(index, { operator: event.target.value as GuardOperator })}
                    >
                      {guardOperators.map((operator) => (
                        <option key={operator} value={operator}>{operator}</option>
                      ))}
                    </select>
                    <input
                      aria-label={`Guard value ${index + 1}`}
                      value={condition.value}
                      onChange={(event) => handleGuidedConditionChange(index, { value: event.target.value })}
                      placeholder="value"
                    />
                    <button
                      type="button"
                      onClick={() => removeGuidedCondition(index)}
                      disabled={guidedConditions.length <= 1}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>

              <ActionButton onClick={addGuidedCondition}>Add condition</ActionButton>
            </div>
          ) : (
            <label className="workflow-inspector-field">
              <span>Raw guard expression (JSON)</span>
              <textarea
                rows={10}
                value={advancedExpression}
                onChange={(event) => handleAdvancedChange(event.target.value)}
                aria-label="Raw guard expression"
              />
              {advancedError ? <span className="workflow-field-validation workflow-field-validation--error">{advancedError}</span> : null}
            </label>
          )}
        </>
      )}
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
  return <EdgeInspectorContent edge={edge} data={data} onChange={onChange} />;
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
  liveWarnings,
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
  liveWarnings: readonly DashboardWorkflowValidationIssue[];
  validationError: string | null;
  publishError: string | null;
}>) {
  const errors = validation?.errors ?? [];
  const validationWarnings = validation?.warnings ?? [];

  const validationBody = (() => {
    if (validation === null) {
      return <p className="meta-text">Run validation to see publish blockers and warnings.</p>;
    }

    if (errors.length === 0 && validationWarnings.length === 0) {
      return <p className="meta-text">No validation issues detected.</p>;
    }

    return (
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
        {validationWarnings.length > 0 ? (
          <div>
            <h4>Warnings</h4>
            <ul className="workflow-issue-list">
              {validationWarnings.map((issue) => (
                <li key={`warn-${issue.code}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  })();

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

      <Panel title="Live warnings">
        {liveWarnings.length === 0 ? (
          <p className="meta-text">No live warnings.</p>
        ) : (
          <ul className="workflow-issue-list">
            {liveWarnings.map((issue) => (
              <li key={`live-${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        )}
      </Panel>

      {validationError ? <p className="run-launch-banner--error" role="alert">{validationError}</p> : null}
      {publishError ? <p className="run-launch-banner--error" role="alert">{publishError}</p> : null}

      <Panel title="Validation results">
        {validationBody}
      </Panel>
    </div>
  );
}
