'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type GuardCondition,
  type GuardExpression,
  type GuardOperator,
  type ProviderExecutionPermissions,
} from '@alphred/shared';
import type { Edge, Node } from '@xyflow/react';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowValidationIssue,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { ActionButton, Panel } from '../../../ui/primitives';

const guardOperators: readonly GuardOperator[] = ['==', '!=', '>', '<', '>=', '<='];
const approvalPolicyOptions = providerApprovalPolicies;
const sandboxModeOptions = providerSandboxModes;
const webSearchModeOptions = providerWebSearchModes;
const workflowNodeRoleOptions: readonly NonNullable<DashboardWorkflowDraftNode['nodeRole']>[] = [
  'standard',
  'spawner',
  'join',
];

type GuardEditorMode = 'guided' | 'advanced';

type GuidedConditionDraft = {
  id: string;
  field: string;
  operator: GuardOperator;
  value: string;
};

let guidedConditionDraftId = 0;

function createGuidedConditionDraft(partial?: Partial<Omit<GuidedConditionDraft, 'id'>>): GuidedConditionDraft {
  guidedConditionDraftId += 1;
  return {
    id: `guard-condition-${guidedConditionDraftId}`,
    field: partial?.field ?? 'decision',
    operator: partial?.operator ?? '==',
    value: partial?.value ?? 'approved',
  };
}

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
  return createGuidedConditionDraft({
    field: condition.field,
    operator: condition.operator,
    value: String(condition.value),
  });
}

function toGuidedState(expression: GuardExpression | null): {
  logic: 'and' | 'or';
  conditions: GuidedConditionDraft[];
} {
  if (!expression) {
    return {
      logic: 'and',
      conditions: [createGuidedConditionDraft()],
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
    conditions: [createGuidedConditionDraft()],
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

function resolveProviderOptionsWithCurrent(
  providerOptions: DashboardAgentProviderOption[],
  currentProvider: string | null,
): DashboardAgentProviderOption[] {
  const effectiveProviderOptions = providerOptions.length > 0
    ? providerOptions
    : [{ provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' }];
  if (!currentProvider) {
    return effectiveProviderOptions;
  }

  const providerValues = new Set(effectiveProviderOptions.map((option) => option.provider));
  if (providerValues.has(currentProvider)) {
    return effectiveProviderOptions;
  }

  return [
    ...effectiveProviderOptions,
    { provider: currentProvider, label: `${currentProvider} (unsupported)`, defaultModel: null },
  ];
}

function compareModelOptions(left: DashboardAgentModelOption, right: DashboardAgentModelOption): number {
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }

  return left.model.localeCompare(right.model);
}

function resolveModelOptionsWithCurrent(
  modelOptions: DashboardAgentModelOption[],
  selectedProvider: string | null,
  currentModel: string | null,
): DashboardAgentModelOption[] {
  const availableModelsForProvider = modelOptions
    .filter((option) => option.provider === selectedProvider)
    .sort(compareModelOptions);
  if (!currentModel) {
    return availableModelsForProvider;
  }

  const modelValues = new Set(availableModelsForProvider.map((option) => option.model));
  if (modelValues.has(currentModel)) {
    return availableModelsForProvider;
  }

  return [
    ...availableModelsForProvider,
    {
      provider: selectedProvider ?? 'unknown',
      model: currentModel,
      label: `${currentModel} (unsupported)`,
      isDefault: false,
      sortOrder: Number.MAX_SAFE_INTEGER,
    },
  ];
}

function resolveDefaultModelForProvider(
  provider: string | null,
  providerOptionsWithCurrent: DashboardAgentProviderOption[],
  modelOptions: DashboardAgentModelOption[],
): string | null {
  if (!provider) {
    return null;
  }

  const providerOption = providerOptionsWithCurrent.find((option) => option.provider === provider);
  if (providerOption?.defaultModel) {
    return providerOption.defaultModel;
  }

  const providerModel = modelOptions.find((option) => option.provider === provider && option.isDefault);
  if (providerModel) {
    return providerModel.model;
  }

  return modelOptions.find((option) => option.provider === provider)?.model ?? null;
}

function normalizeExecutionPermissions(
  currentPermissions: ProviderExecutionPermissions | null | undefined,
  patch: Partial<ProviderExecutionPermissions>,
): ProviderExecutionPermissions | null {
  const merged = currentPermissions
    ? { ...currentPermissions, ...patch }
    : { ...patch };
  const next: ProviderExecutionPermissions = {};
  if (merged.approvalPolicy !== undefined) {
    next.approvalPolicy = merged.approvalPolicy;
  }
  if (merged.sandboxMode !== undefined) {
    next.sandboxMode = merged.sandboxMode;
  }
  if (merged.networkAccessEnabled !== undefined) {
    next.networkAccessEnabled = merged.networkAccessEnabled;
  }
  if (merged.additionalDirectories !== undefined && merged.additionalDirectories.length > 0) {
    next.additionalDirectories = merged.additionalDirectories;
  }
  if (merged.webSearchMode !== undefined) {
    next.webSearchMode = merged.webSearchMode;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function toOptionalSelectValue<T extends string>(value: string): T | undefined {
  return value === '' ? undefined : (value as T);
}

function toOptionalString(value: string): string | null {
  return value.trim().length > 0 ? value : null;
}

function networkAccessSelectValue(executionPermissions: ProviderExecutionPermissions | null | undefined): string {
  if (executionPermissions?.networkAccessEnabled === undefined) {
    return '';
  }

  return executionPermissions.networkAccessEnabled ? 'enabled' : 'disabled';
}

function normalizeNodeRole(nodeRole: DashboardWorkflowDraftNode['nodeRole']): NonNullable<DashboardWorkflowDraftNode['nodeRole']> {
  return workflowNodeRoleOptions.includes(nodeRole ?? 'standard') ? (nodeRole ?? 'standard') : 'standard';
}

function normalizeMaxChildren(maxChildren: DashboardWorkflowDraftNode['maxChildren']): number {
  if (typeof maxChildren !== 'number' || !Number.isFinite(maxChildren) || !Number.isInteger(maxChildren) || maxChildren < 0) {
    return 12;
  }

  return maxChildren;
}

function normalizeEdgeRouteOn(routeOn: DashboardWorkflowDraftEdge['routeOn']): 'success' | 'failure' {
  return routeOn === 'failure' ? 'failure' : 'success';
}

function CodexExecutionPermissionFields({
  executionPermissions,
  onExecutionPermissionsChange,
}: Readonly<{
  executionPermissions: ProviderExecutionPermissions | null | undefined;
  onExecutionPermissionsChange: (patch: Partial<ProviderExecutionPermissions>) => void;
}>) {
  return (
    <>
      <label className="workflow-inspector-field">
        <span>Approval policy</span>
        <select
          value={executionPermissions?.approvalPolicy ?? ''}
          onChange={(event) => {
            const nextValue = event.target.value;
            onExecutionPermissionsChange({
              approvalPolicy: toOptionalSelectValue<(typeof providerApprovalPolicies)[number]>(nextValue),
            });
          }}
        >
          <option value="">Use runtime default</option>
          {approvalPolicyOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>

      <label className="workflow-inspector-field">
        <span>Sandbox mode</span>
        <select
          value={executionPermissions?.sandboxMode ?? ''}
          onChange={(event) => {
            const nextValue = event.target.value;
            onExecutionPermissionsChange({
              sandboxMode: toOptionalSelectValue<(typeof providerSandboxModes)[number]>(nextValue),
            });
          }}
        >
          <option value="">Use runtime default</option>
          {sandboxModeOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>

      <label className="workflow-inspector-field">
        <span>Network access</span>
        <select
          value={networkAccessSelectValue(executionPermissions)}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === '') {
              onExecutionPermissionsChange({ networkAccessEnabled: undefined });
              return;
            }
            onExecutionPermissionsChange({ networkAccessEnabled: nextValue === 'enabled' });
          }}
        >
          <option value="">Use runtime default</option>
          <option value="enabled">enabled</option>
          <option value="disabled">disabled</option>
        </select>
      </label>

      <label className="workflow-inspector-field">
        <span>Web search mode</span>
        <select
          value={executionPermissions?.webSearchMode ?? ''}
          onChange={(event) => {
            const nextValue = event.target.value;
            onExecutionPermissionsChange({
              webSearchMode: toOptionalSelectValue<(typeof providerWebSearchModes)[number]>(nextValue),
            });
          }}
        >
          <option value="">Use runtime default</option>
          {webSearchModeOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>

      <label className="workflow-inspector-field">
        <span>Additional directories (one path per line)</span>
        <textarea
          rows={3}
          value={(executionPermissions?.additionalDirectories ?? []).join('\n')}
          onChange={(event) => {
            const directories = event.target.value
              .split('\n')
              .map((item) => item.trim())
              .filter((item) => item.length > 0);
            onExecutionPermissionsChange({
              additionalDirectories: directories.length > 0 ? directories : undefined,
            });
          }}
        />
      </label>
    </>
  );
}

function AgentNodeFields({
  data,
  selectedProvider,
  providerOptionsWithCurrent,
  modelOptionsWithCurrent,
  isCodexProvider,
  defaultModelForProvider,
  onProviderChange,
  onModelChange,
  onExecutionPermissionsChange,
}: Readonly<{
  data: DashboardWorkflowDraftNode;
  selectedProvider: string | null;
  providerOptionsWithCurrent: DashboardAgentProviderOption[];
  modelOptionsWithCurrent: DashboardAgentModelOption[];
  isCodexProvider: boolean;
  defaultModelForProvider: (provider: string | null) => string | null;
  onProviderChange: (provider: string) => void;
  onModelChange: (model: string | null) => void;
  onExecutionPermissionsChange: (patch: Partial<ProviderExecutionPermissions>) => void;
}>) {
  const hasModelOptions = Boolean(selectedProvider) && modelOptionsWithCurrent.length > 0;
  return (
    <>
      <label className="workflow-inspector-field">
        <span>Provider</span>
        <select value={selectedProvider ?? ''} onChange={(event) => onProviderChange(event.target.value)}>
          {providerOptionsWithCurrent.map((option) => (
            <option key={option.provider} value={option.provider}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="workflow-inspector-field">
        <span>Model</span>
        <select
          value={data.model ?? defaultModelForProvider(selectedProvider) ?? ''}
          onChange={(event) => onModelChange(event.target.value.length > 0 ? event.target.value : null)}
          disabled={!hasModelOptions}
        >
          {hasModelOptions ? null : (
            <option value="">No models available</option>
          )}
          {modelOptionsWithCurrent.map((option) => (
            <option key={`${option.provider}:${option.model}`} value={option.model}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {isCodexProvider ? (
        <CodexExecutionPermissionFields
          executionPermissions={data.executionPermissions}
          onExecutionPermissionsChange={onExecutionPermissionsChange}
        />
      ) : (
        <p className="meta-text">Execution permission controls are currently supported for Codex nodes only.</p>
      )}
    </>
  );
}

export function NodeInspector({
  node,
  providerOptions = [],
  modelOptions = [],
  onChange,
  onAddConnectedNode,
}: Readonly<{
  node: Node | null;
  providerOptions?: DashboardAgentProviderOption[];
  modelOptions?: DashboardAgentModelOption[];
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

  function handleExecutionPermissionsChange(patch: Partial<ProviderExecutionPermissions>): void {
    handleFieldChange('executionPermissions', normalizeExecutionPermissions(data.executionPermissions, patch));
  }

  const nodeType = data.nodeType;
  const isAgent = nodeType === 'agent';
  const normalizedNodeRole = normalizeNodeRole(data.nodeRole);
  const normalizedMaxChildren = normalizeMaxChildren(data.maxChildren);
  const providerOptionsWithCurrent = resolveProviderOptionsWithCurrent(providerOptions, data.provider);
  const selectedProvider = data.provider ?? providerOptionsWithCurrent[0]?.provider ?? null;
  const isCodexProvider = selectedProvider === 'codex';
  const modelOptionsWithCurrent = resolveModelOptionsWithCurrent(modelOptions, selectedProvider, data.model ?? null);

  function defaultModelForProvider(provider: string | null): string | null {
    return resolveDefaultModelForProvider(provider, providerOptionsWithCurrent, modelOptions);
  }

  function handleNodeTypeChange(nextNodeType: DashboardWorkflowDraftNode['nodeType']) {
    if (nextNodeType === 'agent') {
      const nextProvider = selectedProvider;
      const nextModel = data.model ?? defaultModelForProvider(nextProvider);
      onChange({
        ...data,
        nodeType: nextNodeType,
        provider: nextProvider,
        model: nextModel,
        executionPermissions: data.executionPermissions ?? null,
        promptTemplate: data.promptTemplate ?? { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' },
      });
      return;
    }

      onChange({
        ...data,
        nodeType: nextNodeType,
        provider: null,
        model: null,
        nodeRole: 'standard',
        executionPermissions: null,
        promptTemplate: null,
      });
  }

  function handleProviderChange(nextProvider: string) {
    const normalizedProvider = toOptionalString(nextProvider);
    const nextModel = defaultModelForProvider(normalizedProvider);
    onChange({
      ...data,
      provider: normalizedProvider,
      model: nextModel,
      executionPermissions: normalizedProvider === 'codex' ? (data.executionPermissions ?? null) : null,
      promptTemplate: data.promptTemplate ?? { content: 'Describe what to do for this workflow phase.', contentType: 'markdown' },
    });
  }

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
        <select value={data.nodeType} onChange={(event) => handleNodeTypeChange(event.target.value as DashboardWorkflowDraftNode['nodeType'])}>
          <option value="agent">agent</option>
          <option value="human">human</option>
          <option value="tool">tool</option>
        </select>
      </label>

      {isAgent ? (
        <>
          <label className="workflow-inspector-field">
            <span>Role</span>
            <select
              value={normalizedNodeRole}
              onChange={(event) => handleFieldChange('nodeRole', event.target.value as NonNullable<DashboardWorkflowDraftNode['nodeRole']>)}
            >
              {workflowNodeRoleOptions.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <span className="meta-text">Spawner nodes fan out into dynamic children; join nodes aggregate those children.</span>
          </label>

          <label className="workflow-inspector-field">
            <span>Max children</span>
            <input
              type="number"
              min={0}
              value={normalizedMaxChildren}
              onChange={(event) => handleFieldChange('maxChildren', Number(event.target.value))}
            />
          </label>
        </>
      ) : null}

      {isAgent ? (
        <AgentNodeFields
          data={data}
          selectedProvider={selectedProvider}
          providerOptionsWithCurrent={providerOptionsWithCurrent}
          modelOptionsWithCurrent={modelOptionsWithCurrent}
          isCodexProvider={isCodexProvider}
          defaultModelForProvider={defaultModelForProvider}
          onProviderChange={handleProviderChange}
          onModelChange={(model) => handleFieldChange('model', model)}
          onExecutionPermissionsChange={handleExecutionPermissionsChange}
        />
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
    createGuidedConditionDraft(),
  ]);
  const [advancedExpression, setAdvancedExpression] = useState('');
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const routeOn = normalizeEdgeRouteOn(data.routeOn);
  const isFailureRoute = routeOn === 'failure';
  const isAuto = isFailureRoute ? true : data.auto;
  const guardExpression = isAuto ? null : data.guardExpression;

  useEffect(() => {
    const guided = toGuidedState(guardExpression);
    setGuidedLogic(guided.logic);
    setGuidedConditions(guided.conditions);
    setAdvancedExpression(JSON.stringify(guardExpression ?? { field: 'decision', operator: '==', value: 'approved' }, null, 2));
    setAdvancedError(null);
  }, [guardExpression]);

  const guardSummary = useMemo(() => {
    return summarizeGuardExpression(guardExpression);
  }, [guardExpression]);

  function handleRouteOnChange(nextRouteOn: 'success' | 'failure') {
    if (nextRouteOn === 'failure') {
      onChange({
        ...data,
        routeOn: 'failure',
        auto: true,
        guardExpression: null,
      });
      return;
    }

    onChange({
      ...data,
      routeOn: 'success',
      auto: data.auto,
      guardExpression: data.auto ? null : data.guardExpression,
    });
  }

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
      createGuidedConditionDraft(),
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

      <label className="workflow-inspector-field">
        <span>Route</span>
        <select value={routeOn} onChange={(event) => handleRouteOnChange(event.target.value as 'success' | 'failure')}>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
      </label>

      <label className="workflow-inspector-field workflow-inspector-field--inline">
        <span>Auto</span>
        <input
          type="checkbox"
          checked={isAuto}
          disabled={isFailureRoute}
          onChange={(event) => handleAutoChange(event.target.checked)}
        />
      </label>

      {isFailureRoute ? (
        <p className="meta-text">Failure transitions are always auto and do not evaluate guards.</p>
      ) : isAuto ? (
        <p className="meta-text">Auto transitions are unconditional.</p>
      ) : (
        <>
          <div className="workflow-inspector-field">
            <fieldset className="workflow-inspector-field">
              <legend>Guard mode</legend>
              <div className="workflow-segmented-control" aria-label="Guard editor mode">
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
            </fieldset>
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
                  <li key={condition.id} className="workflow-guard-condition-row">
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
