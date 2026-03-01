// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import type { GuardExpression } from '@alphred/shared';
import type { Edge, Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  DashboardAgentModelOption,
  DashboardAgentProviderOption,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
  DashboardWorkflowValidationResult,
} from '../../../../src/server/dashboard-contracts';
import { EdgeInspector, NodeInspector, WorkflowInspector } from './workflow-editor-inspectors';

function createDraftNode(overrides: Partial<DashboardWorkflowDraftNode> = {}): DashboardWorkflowDraftNode {
  return {
    nodeKey: 'design',
    displayName: 'Design',
    nodeType: 'agent',
    nodeRole: 'standard',
    maxChildren: 12,
    provider: 'codex',
    model: 'gpt-5.3-codex',
    maxRetries: 1,
    sequenceIndex: 10,
    position: { x: 0, y: 0 },
    promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
    ...overrides,
  };
}

function createNode(data: DashboardWorkflowDraftNode): Node {
  return {
    id: data.nodeKey,
    position: data.position ?? { x: 0, y: 0 },
    data,
  } as unknown as Node;
}

function createDraftEdge(overrides: Partial<DashboardWorkflowDraftEdge> = {}): DashboardWorkflowDraftEdge {
  return {
    sourceNodeKey: 'design',
    targetNodeKey: 'review',
    priority: 100,
    auto: true,
    guardExpression: null,
    ...overrides,
  };
}

function createEdge(data: DashboardWorkflowDraftEdge): Edge {
  return {
    id: `${data.sourceNodeKey}:${data.targetNodeKey}:${data.priority}`,
    source: data.sourceNodeKey,
    target: data.targetNodeKey,
    data,
  } as unknown as Edge;
}

describe('NodeInspector', () => {
  it('renders an empty state when no node is selected', () => {
    render(<NodeInspector node={null} onChange={vi.fn()} />);

    expect(screen.getByText('Select a node to edit details.')).toBeInTheDocument();
  });

  it('updates display name through onChange', () => {
    const onChange = vi.fn();

    render(<NodeInspector node={createNode(createDraftNode())} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Implementation' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ displayName: 'Implementation' }));
  });

  it('updates node role and max children through onChange', () => {
    const onChange = vi.fn();

    render(<NodeInspector node={createNode(createDraftNode())} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/^Role/), { target: { value: 'spawner' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ nodeRole: 'spawner' }));

    fireEvent.change(screen.getByLabelText(/^Max children/), { target: { value: '8' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxChildren: 8 }));
  });

  it('creates a default markdown prompt template when editing an empty prompt', () => {
    const onChange = vi.fn();

    render(
      <NodeInspector
        node={createNode(createDraftNode({ promptTemplate: null }))}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Run checks.' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        promptTemplate: {
          content: 'Run checks.',
          contentType: 'markdown',
        },
      }),
    );
  });

  it('switches non-agent node types by clearing provider/model/prompt fields', () => {
    const onChange = vi.fn();

    render(<NodeInspector node={createNode(createDraftNode())} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Node type'), { target: { value: 'human' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodeType: 'human',
        nodeRole: 'standard',
        provider: null,
        model: null,
        promptTemplate: null,
      }),
    );
  });

  it('switches to agent with provider/model defaults and starter prompt', () => {
    const onChange = vi.fn();
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' },
      { provider: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet' },
    ];
    const modelOptions: DashboardAgentModelOption[] = [
      { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3', isDefault: true, sortOrder: 10 },
      { provider: 'anthropic', model: 'claude-sonnet', label: 'Claude Sonnet', isDefault: true, sortOrder: 10 },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode({ nodeType: 'human', provider: null, model: null, promptTemplate: null }))}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Node type'), { target: { value: 'agent' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodeType: 'agent',
        provider: 'codex',
        model: 'gpt-5.3-codex',
        promptTemplate: {
          content: 'Describe what to do for this workflow phase.',
          contentType: 'markdown',
        },
      }),
    );
  });

  it('keeps unsupported provider and model values selectable in edit mode', () => {
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' },
    ];
    const modelOptions: DashboardAgentModelOption[] = [
      { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3', isDefault: true, sortOrder: 10 },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode({ provider: 'legacy-provider', model: 'legacy-model' }))}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        onChange={vi.fn()}
      />,
    );

    const providerSelect = screen.getByLabelText('Provider') as HTMLSelectElement;
    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement;

    expect(providerSelect.value).toBe('legacy-provider');
    expect(modelSelect.value).toBe('legacy-model');
    expect(screen.getByRole('option', { name: 'legacy-provider (unsupported)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'legacy-model (unsupported)' })).toBeInTheDocument();
  });

  it('uses provider defaults, provider model defaults, and first model fallback when provider changes', () => {
    const onChange = vi.fn();
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' },
      { provider: 'anthropic', label: 'Anthropic', defaultModel: null },
      { provider: 'openai', label: 'OpenAI', defaultModel: null },
    ];
    const modelOptions: DashboardAgentModelOption[] = [
      { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3', isDefault: true, sortOrder: 10 },
      { provider: 'anthropic', model: 'claude-haiku', label: 'Claude Haiku', isDefault: false, sortOrder: 20 },
      { provider: 'anthropic', model: 'claude-sonnet', label: 'Claude Sonnet', isDefault: true, sortOrder: 10 },
      { provider: 'openai', model: 'gpt-4.2-mini', label: 'GPT-4.2 Mini', isDefault: false, sortOrder: 30 },
      { provider: 'openai', model: 'gpt-5', label: 'GPT-5', isDefault: false, sortOrder: 10 },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode())}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet' }));

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-4.2-mini' }));
  });

  it('edits codex execution permissions fields', () => {
    const onChange = vi.fn();

    render(<NodeInspector node={createNode(createDraftNode())} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Approval policy'), { target: { value: 'on-request' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: { approvalPolicy: 'on-request' },
    }));

    fireEvent.change(screen.getByLabelText('Sandbox mode'), { target: { value: 'workspace-write' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: { sandboxMode: 'workspace-write' },
    }));

    fireEvent.change(screen.getByLabelText('Network access'), { target: { value: 'enabled' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: { networkAccessEnabled: true },
    }));

    fireEvent.change(screen.getByLabelText('Network access'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: null,
    }));

    fireEvent.change(screen.getByLabelText('Web search mode'), { target: { value: 'cached' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: { webSearchMode: 'cached' },
    }));

    fireEvent.change(screen.getByLabelText('Additional directories (one path per line)'), {
      target: { value: '  /tmp/cache  \n\n/tmp/worktree ' },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      executionPermissions: { additionalDirectories: ['/tmp/cache', '/tmp/worktree'] },
    }));
  });

  it('disables model selection when no models exist for the selected provider', () => {
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: null },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode({ provider: 'codex', model: null }))}
        providerOptions={providerOptions}
        modelOptions={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Model')).toBeDisabled();
    expect(screen.getByRole('option', { name: 'No models available' })).toBeInTheDocument();
  });

  it('invokes onAddConnectedNode with the active node key', () => {
    const onAddConnectedNode = vi.fn();

    render(
      <NodeInspector
        node={createNode(createDraftNode({ nodeKey: 'implement' }))}
        onChange={vi.fn()}
        onAddConnectedNode={onAddConnectedNode}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add connected node' }));

    expect(onAddConnectedNode).toHaveBeenCalledTimes(1);
    expect(onAddConnectedNode).toHaveBeenCalledWith('implement');
  });

  it('clears execution permissions when switching provider away from codex', () => {
    const onChange = vi.fn();
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' },
      { provider: 'claude', label: 'Claude', defaultModel: 'claude-3-7-sonnet-latest' },
    ];
    const modelOptions: DashboardAgentModelOption[] = [
      { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3', isDefault: true, sortOrder: 10 },
      { provider: 'claude', model: 'claude-3-7-sonnet-latest', label: 'Claude Sonnet', isDefault: true, sortOrder: 10 },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode({
          executionPermissions: {
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
          },
        }))}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'claude',
      executionPermissions: null,
    }));
  });

  it('shows execution-permission support guidance for non-codex providers', () => {
    const providerOptions: DashboardAgentProviderOption[] = [
      { provider: 'codex', label: 'Codex', defaultModel: 'gpt-5.3-codex' },
      { provider: 'claude', label: 'Claude', defaultModel: 'claude-3-7-sonnet-latest' },
    ];
    const modelOptions: DashboardAgentModelOption[] = [
      { provider: 'codex', model: 'gpt-5.3-codex', label: 'GPT-5.3', isDefault: true, sortOrder: 10 },
      { provider: 'claude', model: 'claude-3-7-sonnet-latest', label: 'Claude Sonnet', isDefault: true, sortOrder: 10 },
    ];

    render(
      <NodeInspector
        node={createNode(createDraftNode({ provider: 'claude', model: 'claude-3-7-sonnet-latest' }))}
        providerOptions={providerOptions}
        modelOptions={modelOptions}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Execution permission controls are currently supported for Codex nodes only.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Approval policy')).toBeNull();
  });
});

describe('EdgeInspector', () => {
  it('renders an empty state when no edge is selected', () => {
    render(<EdgeInspector edge={null} onChange={vi.fn()} />);

    expect(screen.getByText('Select a transition to edit details.')).toBeInTheDocument();
  });

  it('updates priority and toggles from auto to guarded with fallback condition', () => {
    const onChange = vi.fn();

    render(<EdgeInspector edge={createEdge(createDraftEdge({ auto: true, guardExpression: null }))} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '42' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 42 }));

    fireEvent.click(screen.getByLabelText('Auto'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auto: false,
        guardExpression: { field: 'decision', operator: '==', value: 'approved' },
      }),
    );
  });

  it('toggles to auto by clearing guard expressions', () => {
    const onChange = vi.fn();

    render(
      <EdgeInspector
        edge={createEdge(
          createDraftEdge({
            auto: false,
            guardExpression: { field: 'score', operator: '>=', value: 10 },
          }),
        )}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Auto'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auto: true,
        guardExpression: null,
      }),
    );
  });

  it('switches route to failure and enforces auto-only transition behavior', () => {
    const onChange = vi.fn();

    render(
      <EdgeInspector
        edge={createEdge(createDraftEdge({
          routeOn: 'success',
          auto: false,
          guardExpression: { field: 'decision', operator: '==', value: 'approved' },
        }))}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Route'), { target: { value: 'failure' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      routeOn: 'failure',
      auto: true,
      guardExpression: null,
    }));
  });

  it('shows failure-route messaging and disables auto toggle for failure transitions', () => {
    render(
      <EdgeInspector
        edge={createEdge(createDraftEdge({
          routeOn: 'failure',
          auto: true,
          guardExpression: null,
        }))}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Failure transitions are always auto and do not evaluate guards.')).toBeInTheDocument();
    expect(screen.getByLabelText('Auto')).toBeDisabled();
  });

  it('builds guided expressions and coerces boolean/number guard values', () => {
    const onChange = vi.fn();

    render(
      <EdgeInspector
        edge={createEdge(
          createDraftEdge({
            auto: false,
            guardExpression: { field: 'decision', operator: '==', value: 'approved' },
          }),
        )}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Guard value 1'), { target: { value: 'true' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        guardExpression: { field: 'decision', operator: '==', value: true },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    fireEvent.change(screen.getByLabelText('Group logic'), { target: { value: 'or' } });
    fireEvent.change(screen.getByLabelText('Guard value 2'), { target: { value: '7.5' } });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        guardExpression: {
          logic: 'or',
          conditions: [
            { field: 'decision', operator: '==', value: true },
            { field: 'decision', operator: '==', value: 7.5 },
          ],
        },
      }),
    );
  });

  it('prevents removing the final guided condition', () => {
    const onChange = vi.fn();

    render(
      <EdgeInspector
        edge={createEdge(
          createDraftEdge({
            auto: false,
            guardExpression: { field: 'decision', operator: '==', value: 'approved' },
          }),
        )}
        onChange={onChange}
      />,
    );

    const removeButton = screen.getByRole('button', { name: 'Remove' });
    expect(removeButton).toBeDisabled();
    fireEvent.click(removeButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts valid advanced JSON and rejects invalid guard shapes', () => {
    const onChange = vi.fn();

    render(
      <EdgeInspector
        edge={createEdge(
          createDraftEdge({
            auto: false,
            guardExpression: { field: 'decision', operator: '==', value: 'approved' },
          }),
        )}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));

    fireEvent.change(screen.getByLabelText('Raw guard expression'), {
      target: {
        value: JSON.stringify({ field: 'score', operator: '>=', value: 10 }),
      },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auto: false,
        guardExpression: { field: 'score', operator: '>=', value: 10 },
      }),
    );

    fireEvent.change(screen.getByLabelText('Raw guard expression'), {
      target: {
        value: JSON.stringify({ field: 'score', operator: 'contains', value: 10 }),
      },
    });
    expect(screen.getByText('Guard expression must be a valid condition or logical group JSON object.')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('loads guided fallback defaults for nested-only guard groups', () => {
    const nestedOnly: GuardExpression = {
      logic: 'and',
      conditions: [
        {
          logic: 'or',
          conditions: [{ field: 'decision', operator: '==', value: 'approved' }],
        },
      ],
    };

    render(
      <EdgeInspector
        edge={createEdge(createDraftEdge({ auto: false, guardExpression: nestedOnly }))}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Group logic')).toHaveValue('and');
    expect(screen.getByLabelText('Guard field 1')).toHaveValue('decision');
    expect(screen.getByLabelText('Guard value 1')).toHaveValue('approved');
  });

  it('loads guided state from logical expressions by keeping flat conditions only', () => {
    const mixed: GuardExpression = {
      logic: 'or',
      conditions: [
        { field: 'result', operator: '==', value: 'retry' },
        {
          logic: 'and',
          conditions: [{ field: 'attempts', operator: '>=', value: 3 }],
        },
      ],
    };

    render(
      <EdgeInspector
        edge={createEdge(createDraftEdge({ auto: false, guardExpression: mixed }))}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Group logic')).toHaveValue('or');
    expect(screen.getByLabelText('Guard field 1')).toHaveValue('result');
    expect(screen.getByLabelText('Guard value 1')).toHaveValue('retry');
  });
});

describe('WorkflowInspector', () => {
  function renderWorkflowInspector(args?: Readonly<{
    validation?: DashboardWorkflowValidationResult | null;
    initialRunnableNodeKeys?: readonly string[];
    liveWarnings?: readonly { code: string; message: string }[];
    validationError?: string | null;
    publishError?: string | null;
  }>) {
    const onNameChange = vi.fn();
    const onDescriptionChange = vi.fn();
    const onVersionNotesChange = vi.fn();

    render(
      <WorkflowInspector
        name="Design Review"
        description="Current description"
        versionNotes="Current notes"
        onNameChange={onNameChange}
        onDescriptionChange={onDescriptionChange}
        onVersionNotesChange={onVersionNotesChange}
        initialRunnableNodeKeys={args?.initialRunnableNodeKeys ?? []}
        validation={args?.validation ?? null}
        liveWarnings={(args?.liveWarnings as readonly { code: string; message: string }[] | undefined) ?? []}
        validationError={args?.validationError ?? null}
        publishError={args?.publishError ?? null}
      />,
    );

    return { onNameChange, onDescriptionChange, onVersionNotesChange };
  }

  it('updates workflow name, description, and version notes callbacks', () => {
    const { onNameChange, onDescriptionChange, onVersionNotesChange } = renderWorkflowInspector();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated workflow' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated description' } });
    fireEvent.change(screen.getByLabelText(/^Version notes/), { target: { value: 'Updated notes' } });

    expect(onNameChange).toHaveBeenCalledWith('Updated workflow');
    expect(onDescriptionChange).toHaveBeenCalledWith('Updated description');
    expect(onVersionNotesChange).toHaveBeenCalledWith('Updated notes');
  });

  it('renders initial runnable nodes and live warnings', () => {
    renderWorkflowInspector({
      initialRunnableNodeKeys: ['design', 'review'],
      liveWarnings: [{ code: 'warn_loop', message: 'Potential cycle detected.' }],
    });

    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
    expect(screen.getByText('Potential cycle detected.')).toBeInTheDocument();
  });

  it('renders empty-state helper text for runnable nodes and live warnings', () => {
    renderWorkflowInspector({
      initialRunnableNodeKeys: [],
      liveWarnings: [],
    });

    expect(screen.getByText('None detected.')).toBeInTheDocument();
    expect(screen.getByText('No live warnings.')).toBeInTheDocument();
  });

  it('renders validation idle, success, and issue states', () => {
    const { rerender } = render(
      <WorkflowInspector
        name="Design Review"
        description=""
        versionNotes=""
        onNameChange={vi.fn()}
        onDescriptionChange={vi.fn()}
        onVersionNotesChange={vi.fn()}
        initialRunnableNodeKeys={[]}
        validation={null}
        liveWarnings={[]}
        validationError={null}
        publishError={null}
      />,
    );
    expect(screen.getByText('Run validation to see publish blockers and warnings.')).toBeInTheDocument();

    rerender(
      <WorkflowInspector
        name="Design Review"
        description=""
        versionNotes=""
        onNameChange={vi.fn()}
        onDescriptionChange={vi.fn()}
        onVersionNotesChange={vi.fn()}
        initialRunnableNodeKeys={[]}
        validation={{ errors: [], warnings: [], initialRunnableNodeKeys: [] }}
        liveWarnings={[]}
        validationError={null}
        publishError={null}
      />,
    );
    expect(screen.getByText('No validation issues detected.')).toBeInTheDocument();

    rerender(
      <WorkflowInspector
        name="Design Review"
        description=""
        versionNotes=""
        onNameChange={vi.fn()}
        onDescriptionChange={vi.fn()}
        onVersionNotesChange={vi.fn()}
        initialRunnableNodeKeys={[]}
        validation={{
          errors: [{ code: 'missing_prompt', message: 'At least one node is missing a prompt.' }],
          warnings: [{ code: 'no_retry', message: 'Retry path is not defined.' }],
          initialRunnableNodeKeys: [],
        }}
        liveWarnings={[]}
        validationError={null}
        publishError={null}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Errors' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Warnings' })).toBeInTheDocument();
    expect(screen.getByText('At least one node is missing a prompt.')).toBeInTheDocument();
    expect(screen.getByText('Retry path is not defined.')).toBeInTheDocument();
  });

  it('renders validation and publish failures as alerts', () => {
    renderWorkflowInspector({
      validationError: 'Validation request failed.',
      publishError: 'Publish failed.',
    });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Validation request failed.');
    expect(alerts[1]).toHaveTextContent('Publish failed.');
  });
});
