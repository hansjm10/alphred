import { UnknownAgentProviderError, resolveAgentProvider } from '@alphred/agents';
import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type GuardExpression,
  type ProviderExecutionPermissions,
} from '@alphred/shared';
import type { AgentCatalog } from './agent-catalog';
import type {
  DashboardWorkflowDraftTopology,
  DashboardWorkflowValidationIssue,
  DashboardWorkflowValidationResult,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';
import { isRecord } from './dashboard-utils';

const workflowNodeTypes = new Set(['agent', 'human', 'tool']);
const workflowNodeRoles = new Set(['standard', 'spawner', 'join']);
const guardOperators = new Set(['==', '!=', '>', '<', '>=', '<=']);
const executionApprovalPolicies = new Set(providerApprovalPolicies);
const executionSandboxModes = new Set(providerSandboxModes);
const executionWebSearchModes = new Set(providerWebSearchModes);
const defaultWorkflowNodeRole = 'standard';

export function isGuardExpression(value: unknown): value is GuardExpression {
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

  if (typeof value.operator !== 'string' || !guardOperators.has(value.operator)) {
    return false;
  }

  return ['string', 'number', 'boolean'].includes(typeof value.value);
}

export function normalizeExecutionPermissions(
  value: ProviderExecutionPermissions | null | undefined,
): ProviderExecutionPermissions | null {
  if (!value || !isRecord(value)) {
    return null;
  }

  const normalized: ProviderExecutionPermissions = {};

  if (typeof value.approvalPolicy === 'string' && executionApprovalPolicies.has(value.approvalPolicy)) {
    normalized.approvalPolicy = value.approvalPolicy;
  }

  if (typeof value.sandboxMode === 'string' && executionSandboxModes.has(value.sandboxMode)) {
    normalized.sandboxMode = value.sandboxMode;
  }

  if (typeof value.networkAccessEnabled === 'boolean') {
    normalized.networkAccessEnabled = value.networkAccessEnabled;
  }

  if (Array.isArray(value.additionalDirectories)) {
    const normalizedDirectories = value.additionalDirectories
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item.length > 0);
    if (normalizedDirectories.length > 0) {
      normalized.additionalDirectories = normalizedDirectories;
    }
  }

  if (typeof value.webSearchMode === 'string' && executionWebSearchModes.has(value.webSearchMode)) {
    normalized.webSearchMode = value.webSearchMode;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isDraftNodeRole(value: unknown): value is 'standard' | 'spawner' | 'join' {
  return typeof value === 'string' && workflowNodeRoles.has(value);
}

function normalizeDraftNodeRole(value: unknown): 'standard' | 'spawner' | 'join' {
  if (isDraftNodeRole(value)) {
    return value;
  }

  return defaultWorkflowNodeRole;
}

export function normalizeWorkflowTreeKey(rawValue: unknown): string {
  if (typeof rawValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow tree key must be a string.', {
      status: 400,
    });
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'Workflow tree key cannot be empty.', {
      status: 400,
    });
  }

  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new DashboardIntegrationError(
      'invalid_request',
      'Workflow tree key must be lowercase and contain only a-z, 0-9, and hyphens.',
      { status: 400 },
    );
  }

  return value;
}

export function isWorkflowTreeUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;

  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message.toLowerCase()
      : '';

  const isUniqueConstraint =
    code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('unique constraint failed');
  if (!isUniqueConstraint) {
    return false;
  }

  return (
    message.includes('workflow_trees_tree_key_single_draft_uq') ||
    (message.includes('workflow_trees.tree_key') && message.includes('workflow_trees.version')) ||
    message.includes('workflow_trees_tree_key_version_uq') ||
    message.includes('workflow_trees.tree_key')
  );
}

export function computeInitialRunnableNodeKeys(
  nodes: readonly { nodeKey: string }[],
  edges: readonly { targetNodeKey: string }[],
): string[] {
  const incoming = new Set(edges.map(edge => edge.targetNodeKey));
  return nodes.filter(node => !incoming.has(node.nodeKey)).map(node => node.nodeKey);
}

function detectCycle(
  nodes: readonly { nodeKey: string }[],
  edges: readonly { sourceNodeKey: string; targetNodeKey: string }[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.nodeKey, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.sourceNodeKey)?.push(edge.targetNodeKey);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(nodeKey: string): boolean {
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }

    visiting.add(nodeKey);
    const next = adjacency.get(nodeKey) ?? [];
    for (const target of next) {
      if (visit(target)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  }

  for (const node of nodes) {
    if (visit(node.nodeKey)) {
      return true;
    }
  }

  return false;
}

export function normalizeDraftTopologyKeys(
  topology: Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'>,
): Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'> {
  return {
    nodes: topology.nodes.map(node => ({
      ...node,
      nodeKey: node.nodeKey.trim(),
      provider: node.provider?.trim() ? node.provider.trim() : null,
      model: node.model?.trim() ? node.model.trim() : null,
      executionPermissions: node.executionPermissions ?? null,
    })),
    edges: topology.edges.map(edge => ({
      ...edge,
      sourceNodeKey: edge.sourceNodeKey.trim(),
      targetNodeKey: edge.targetNodeKey.trim(),
      routeOn: edge.routeOn === 'failure' ? 'failure' : 'success',
    })),
  };
}

export function validateDraftTopology(
  topology: Pick<DashboardWorkflowDraftTopology, 'nodes' | 'edges'>,
  mode: 'save' | 'publish',
  catalog: Pick<AgentCatalog, 'modelSetByProvider' | 'defaultModelByProvider'>,
): DashboardWorkflowValidationResult {
  const normalizedTopology = normalizeDraftTopologyKeys(topology);
  const errors: DashboardWorkflowValidationIssue[] = [];
  const warnings: DashboardWorkflowValidationIssue[] = [];

  if (normalizedTopology.nodes.length === 0) {
    errors.push({ code: 'no_nodes', message: 'Workflow must include at least one node.' });
  }

  const nodeKeys = new Set<string>();
  const nodeRoleByKey = new Map<string, 'standard' | 'spawner' | 'join'>();
  const sequenceIndexes = new Set<number>();
  for (const node of normalizedTopology.nodes) {
    if (!workflowNodeTypes.has(node.nodeType)) {
      errors.push({ code: 'node_type_invalid', message: `Node type "${node.nodeType}" is not supported.` });
      continue;
    }

    const trimmedKey = node.nodeKey.trim();
    if (trimmedKey.length === 0) {
      errors.push({ code: 'node_key_missing', message: 'Node key is required.' });
      continue;
    }
    if (nodeKeys.has(trimmedKey)) {
      errors.push({ code: 'duplicate_node_key', message: `Duplicate node key "${trimmedKey}".` });
    }
    nodeKeys.add(trimmedKey);

    if (sequenceIndexes.has(node.sequenceIndex)) {
      errors.push({
        code: 'duplicate_node_sequence_index',
        message: `Duplicate node sequence index ${node.sequenceIndex}.`,
      });
    }
    sequenceIndexes.add(node.sequenceIndex);

    const trimmedName = node.displayName.trim();
    if (trimmedName.length === 0) {
      errors.push({ code: 'node_name_missing', message: `Node "${trimmedKey}" must have a display name.` });
    }

    if (
      node.nodeRole !== undefined
      && node.nodeRole !== null
      && !isDraftNodeRole(node.nodeRole)
    ) {
      errors.push({
        code: 'node_role_invalid',
        message: `Node "${trimmedKey}" has unsupported node role "${String(node.nodeRole)}".`,
      });
    }
    const nodeRole = normalizeDraftNodeRole(node.nodeRole);
    nodeRoleByKey.set(trimmedKey, nodeRole);

    if (
      node.maxChildren !== undefined
      && (!Number.isFinite(node.maxChildren) || !Number.isInteger(node.maxChildren) || node.maxChildren < 0)
    ) {
      errors.push({
        code: 'max_children_invalid',
        message: `Node "${trimmedKey}" must set maxChildren as a non-negative integer.`,
      });
    }

    if ((nodeRole === 'spawner' || nodeRole === 'join') && node.nodeType !== 'agent') {
      errors.push({
        code: 'node_role_requires_agent',
        message: `Node "${trimmedKey}" uses role "${nodeRole}" but only agent nodes may use spawner/join roles.`,
      });
    }

    const executionPermissions = node.executionPermissions ?? null;
    if (node.nodeType !== 'agent' && executionPermissions !== null) {
      errors.push({
        code: 'execution_permissions_non_agent',
        message: `Node "${trimmedKey}" cannot set execution permissions because only agent nodes are executable.`,
      });
    }

    if (mode === 'publish' && node.nodeType !== 'agent') {
      errors.push({
        code: 'unsupported_node_type',
        message: `Node "${trimmedKey}" has unsupported type "${node.nodeType}" and cannot be published yet.`,
      });
    }

    if (node.nodeType === 'agent') {
      const provider = node.provider?.trim() ?? null;
      const model = node.model?.trim() ?? null;

      if (!provider) {
        errors.push({ code: 'agent_provider_missing', message: `Agent node "${trimmedKey}" must have a provider.` });
      } else {
        let providerSupported = true;
        try {
          resolveAgentProvider(provider);
        } catch (error) {
          providerSupported = false;
          const availableProviders =
            error instanceof UnknownAgentProviderError && error.availableProviders.length > 0
              ? error.availableProviders.join(', ')
              : '(none)';
          errors.push({
            code: 'agent_provider_invalid',
            message: `Agent node "${trimmedKey}" has unsupported provider value ${JSON.stringify(provider)}. Available providers: ${availableProviders}.`,
          });
        }

        const supportedModels = catalog.modelSetByProvider.get(provider);
        if (!model) {
          errors.push({ code: 'agent_model_missing', message: `Agent node "${trimmedKey}" must have a model.` });
        } else if (providerSupported && (!supportedModels || !supportedModels.has(model))) {
          const availableModels = supportedModels && supportedModels.size > 0 ? [...supportedModels].join(', ') : '(none)';
          errors.push({
            code: 'agent_model_invalid',
            message: `Agent node "${trimmedKey}" has unsupported model value ${JSON.stringify(model)} for provider ${JSON.stringify(provider)}. Available models: ${availableModels}.`,
          });
        }

        if (executionPermissions !== null && provider !== 'codex') {
          errors.push({
            code: 'execution_permissions_provider_unsupported',
            message: `Agent node "${trimmedKey}" cannot set execution permissions for provider ${JSON.stringify(provider)}.`,
          });
        }
      }

      if (executionPermissions !== null) {
        if (
          executionPermissions.approvalPolicy !== undefined &&
          !executionApprovalPolicies.has(executionPermissions.approvalPolicy)
        ) {
          errors.push({
            code: 'execution_permissions_approval_policy_invalid',
            message: `Agent node "${trimmedKey}" has unsupported execution approvalPolicy ${JSON.stringify(executionPermissions.approvalPolicy)}.`,
          });
        }

        if (
          executionPermissions.sandboxMode !== undefined &&
          !executionSandboxModes.has(executionPermissions.sandboxMode)
        ) {
          errors.push({
            code: 'execution_permissions_sandbox_mode_invalid',
            message: `Agent node "${trimmedKey}" has unsupported execution sandboxMode ${JSON.stringify(executionPermissions.sandboxMode)}.`,
          });
        }

        if (
          executionPermissions.networkAccessEnabled !== undefined &&
          typeof executionPermissions.networkAccessEnabled !== 'boolean'
        ) {
          errors.push({
            code: 'execution_permissions_network_access_invalid',
            message: `Agent node "${trimmedKey}" must set execution networkAccessEnabled as a boolean.`,
          });
        }

        if (executionPermissions.additionalDirectories !== undefined) {
          if (
            !Array.isArray(executionPermissions.additionalDirectories) ||
            executionPermissions.additionalDirectories.some(item => typeof item !== 'string' || item.trim().length === 0)
          ) {
            errors.push({
              code: 'execution_permissions_additional_directories_invalid',
              message: `Agent node "${trimmedKey}" must set execution additionalDirectories as non-empty strings.`,
            });
          }
        }

        if (
          executionPermissions.webSearchMode !== undefined &&
          !executionWebSearchModes.has(executionPermissions.webSearchMode)
        ) {
          errors.push({
            code: 'execution_permissions_web_search_mode_invalid',
            message: `Agent node "${trimmedKey}" has unsupported execution webSearchMode ${JSON.stringify(executionPermissions.webSearchMode)}.`,
          });
        }
      }

      if (!node.promptTemplate || node.promptTemplate.content.trim().length === 0) {
        errors.push({ code: 'agent_prompt_missing', message: `Agent node "${trimmedKey}" must have a prompt.` });
      }
    }
  }

  const prioritiesBySourceAndRoute = new Map<string, Set<number>>();
  for (const edge of normalizedTopology.edges) {
    if (!nodeKeys.has(edge.sourceNodeKey)) {
      errors.push({
        code: 'edge_source_missing',
        message: `Transition source node "${edge.sourceNodeKey}" was not found.`,
      });
    }
    if (!nodeKeys.has(edge.targetNodeKey)) {
      errors.push({
        code: 'edge_target_missing',
        message: `Transition target node "${edge.targetNodeKey}" was not found.`,
      });
    }

    if (!Number.isFinite(edge.priority) || !Number.isInteger(edge.priority) || edge.priority < 0) {
      errors.push({
        code: 'transition_priority_invalid',
        message: `Transition priority ${edge.priority} from "${edge.sourceNodeKey}" must be a non-negative integer.`,
      });
    } else {
      const priorityKey = `${edge.sourceNodeKey}:${edge.routeOn}`;
      const priorities = prioritiesBySourceAndRoute.get(priorityKey) ?? new Set<number>();
      if (priorities.has(edge.priority)) {
        errors.push({
          code: 'duplicate_transition_priority',
          message: `Duplicate transition priority ${edge.priority} from "${edge.sourceNodeKey}" on route "${edge.routeOn}".`,
        });
      }
      priorities.add(edge.priority);
      prioritiesBySourceAndRoute.set(priorityKey, priorities);
    }

    if (edge.routeOn === 'failure') {
      if (!edge.auto) {
        errors.push({
          code: 'failure_route_must_be_auto',
          message: `Failure transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must be auto.`,
        });
      }

      if (edge.guardExpression !== null) {
        errors.push({
          code: 'failure_route_has_guard',
          message: `Failure transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must not have a guard.`,
        });
      }
      continue;
    }

    if (edge.auto) {
      if (edge.guardExpression !== null) {
        errors.push({
          code: 'auto_edge_has_guard',
          message: `Auto transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must not have a guard.`,
        });
      }
    } else if (edge.guardExpression === null) {
      errors.push({
        code: 'guard_missing',
        message: `Guarded transition ${edge.sourceNodeKey} → ${edge.targetNodeKey} must include a guard definition.`,
      });
    } else if (!isGuardExpression(edge.guardExpression)) {
      errors.push({
        code: 'guard_invalid',
        message: `Guard expression for ${edge.sourceNodeKey} → ${edge.targetNodeKey} must be parseable.`,
      });
    }
  }

  for (const node of normalizedTopology.nodes) {
    const nodeRole = nodeRoleByKey.get(node.nodeKey) ?? normalizeDraftNodeRole(node.nodeRole);
    if (nodeRole !== 'spawner') {
      continue;
    }

    const successEdges = normalizedTopology.edges.filter(
      edge => edge.sourceNodeKey === node.nodeKey && edge.routeOn !== 'failure',
    );
    if (successEdges.length !== 1) {
      errors.push({
        code: 'spawner_success_edge_count_invalid',
        message: `Spawner node "${node.nodeKey}" must have exactly one success transition to a join node.`,
      });
      continue;
    }

    const targetNodeRole = nodeRoleByKey.get(successEdges[0].targetNodeKey);
    if (targetNodeRole !== 'join') {
      errors.push({
        code: 'spawner_success_target_not_join',
        message: `Spawner node "${node.nodeKey}" must route its success transition to a join node.`,
      });
    }
  }

  const initialRunnableNodeKeys = computeInitialRunnableNodeKeys(normalizedTopology.nodes, normalizedTopology.edges);
  if (normalizedTopology.nodes.length > 0 && initialRunnableNodeKeys.length === 0) {
    errors.push({
      code: 'no_initial_nodes',
      message: 'Workflow must include at least one initial runnable node (a node with no incoming transitions).',
    });
  } else if (initialRunnableNodeKeys.length > 1) {
    warnings.push({
      code: 'multiple_initial_nodes',
      message: `Multiple initial runnable nodes detected: ${initialRunnableNodeKeys.join(', ')}.`,
    });
  }

  const hasCycles = detectCycle(normalizedTopology.nodes, normalizedTopology.edges);
  if (hasCycles) {
    warnings.push({ code: 'cycles_present', message: 'Cycles are present in the workflow graph.' });
  }

  const outgoingBySource = new Map<string, number>();
  for (const edge of normalizedTopology.edges) {
    outgoingBySource.set(edge.sourceNodeKey, (outgoingBySource.get(edge.sourceNodeKey) ?? 0) + 1);
  }
  for (const node of normalizedTopology.nodes) {
    if ((outgoingBySource.get(node.nodeKey) ?? 0) === 0) {
      warnings.push({
        code: 'terminal_node',
        message: `Node "${node.nodeKey}" has no outgoing transitions (terminal).`,
      });
    }
  }

  return { errors, warnings, initialRunnableNodeKeys };
}
