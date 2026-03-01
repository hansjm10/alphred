import { NextResponse } from 'next/server';
import {
  providerApprovalPolicies,
  providerSandboxModes,
  providerWebSearchModes,
  type GuardExpression,
  type ProviderExecutionPermissions,
} from '@alphred/shared';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import type {
  DashboardSaveWorkflowDraftRequest,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
} from '../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';
import { isRecord, optionalStringField, parsePositiveIntegerQueryParam, requireRecord } from '../../_shared/validation';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

const guardOperators = new Set(['==', '!=', '>', '<', '>=', '<=']);
const edgeRouteOnValues = new Set(['success', 'failure']);
const nodeRoleValues = new Set(['standard', 'spawner', 'join']);
const executionPermissionKeys = new Set([
  'approvalPolicy',
  'sandboxMode',
  'networkAccessEnabled',
  'additionalDirectories',
  'webSearchMode',
]);
const approvalPolicyValues = new Set(providerApprovalPolicies);
const sandboxModeValues = new Set(providerSandboxModes);
const webSearchModeValues = new Set(providerWebSearchModes);

function executionPermissionsFieldPath(index: number, field?: string): string {
  if (!field) {
    return `nodes[${index}].executionPermissions`;
  }

  return `nodes[${index}].executionPermissions.${field}`;
}

function createExecutionPermissionsError(index: number, field: string | undefined, message: string): DashboardIntegrationError {
  return new DashboardIntegrationError('invalid_request', message, {
    status: 400,
    details: { field: executionPermissionsFieldPath(index, field) },
  });
}

function throwInvalidExecutionPermissions(index: number, field?: string): never {
  const suffix = field ? `.${field}` : '';
  throw createExecutionPermissionsError(
    index,
    field,
    `Draft node at index ${index} has invalid executionPermissions${suffix}.`,
  );
}

function assertSupportedExecutionPermissionKeys(rawPermissions: Record<string, unknown>, index: number): void {
  for (const key of Object.keys(rawPermissions)) {
    if (executionPermissionKeys.has(key)) {
      continue;
    }

    throw createExecutionPermissionsError(
      index,
      key,
      `Draft node at index ${index} has unsupported executionPermissions field "${key}".`,
    );
  }
}

function parseExecutionPermissionApprovalPolicy(
  rawPermissions: Record<string, unknown>,
  index: number,
): (typeof providerApprovalPolicies)[number] | undefined {
  const approvalPolicy = rawPermissions.approvalPolicy;
  if (approvalPolicy === undefined) {
    return undefined;
  }

  if (
    typeof approvalPolicy !== 'string'
    || !approvalPolicyValues.has(approvalPolicy as (typeof providerApprovalPolicies)[number])
  ) {
    throwInvalidExecutionPermissions(index, 'approvalPolicy');
  }

  return approvalPolicy as (typeof providerApprovalPolicies)[number];
}

function parseExecutionPermissionSandboxMode(
  rawPermissions: Record<string, unknown>,
  index: number,
): (typeof providerSandboxModes)[number] | undefined {
  const sandboxMode = rawPermissions.sandboxMode;
  if (sandboxMode === undefined) {
    return undefined;
  }

  if (
    typeof sandboxMode !== 'string'
    || !sandboxModeValues.has(sandboxMode as (typeof providerSandboxModes)[number])
  ) {
    throwInvalidExecutionPermissions(index, 'sandboxMode');
  }

  return sandboxMode as (typeof providerSandboxModes)[number];
}

function parseExecutionPermissionNetworkAccessEnabled(
  rawPermissions: Record<string, unknown>,
  index: number,
): boolean | undefined {
  const networkAccessEnabled = rawPermissions.networkAccessEnabled;
  if (networkAccessEnabled === undefined) {
    return undefined;
  }

  if (typeof networkAccessEnabled !== 'boolean') {
    throwInvalidExecutionPermissions(index, 'networkAccessEnabled');
  }

  return networkAccessEnabled;
}

function parseExecutionPermissionAdditionalDirectories(
  rawPermissions: Record<string, unknown>,
  index: number,
): string[] | undefined {
  const additionalDirectories = rawPermissions.additionalDirectories;
  if (additionalDirectories === undefined) {
    return undefined;
  }

  if (!Array.isArray(additionalDirectories) || additionalDirectories.some((item) => typeof item !== 'string')) {
    throwInvalidExecutionPermissions(index, 'additionalDirectories');
  }

  return [...additionalDirectories];
}

function parseExecutionPermissionWebSearchMode(
  rawPermissions: Record<string, unknown>,
  index: number,
): (typeof providerWebSearchModes)[number] | undefined {
  const webSearchMode = rawPermissions.webSearchMode;
  if (webSearchMode === undefined) {
    return undefined;
  }

  if (
    typeof webSearchMode !== 'string'
    || !webSearchModeValues.has(webSearchMode as (typeof providerWebSearchModes)[number])
  ) {
    throwInvalidExecutionPermissions(index, 'webSearchMode');
  }

  return webSearchMode as (typeof providerWebSearchModes)[number];
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

  if (typeof value.operator !== 'string' || !guardOperators.has(value.operator)) {
    return false;
  }

  return ['string', 'number', 'boolean'].includes(typeof value.value);
}

function parseDraftEdgeGuardExpression(value: unknown, index: number): GuardExpression | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isGuardExpression(value)) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Draft edge at index ${index} has an invalid guardExpression.`,
      {
        status: 400,
        details: { field: `edges[${index}].guardExpression` },
      },
    );
  }

  return value;
}

function parseDraftEdgeRouteOn(value: unknown, index: number): 'success' | 'failure' {
  if (value === undefined || value === null) {
    return 'success';
  }

  if (typeof value !== 'string' || !edgeRouteOnValues.has(value)) {
    throw new DashboardIntegrationError('invalid_request', `Draft edge at index ${index} has an invalid routeOn mode.`, {
      status: 400,
      details: { field: `edges[${index}].routeOn` },
    });
  }

  return value as 'success' | 'failure';
}

function parseDraftNodePosition(value: unknown, index: number): { x: number; y: number } | null {
  if (value === null) {
    return null;
  }

  if (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  ) {
    return { x: value.x, y: value.y };
  }

  throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid position.`, {
    status: 400,
    details: { field: `nodes[${index}].position` },
  });
}

function parseDraftNodeRole(value: unknown, index: number): DashboardWorkflowDraftNode['nodeRole'] {
  if (value === undefined || value === null) {
    return 'standard';
  }

  if (typeof value !== 'string' || !nodeRoleValues.has(value)) {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid nodeRole.`, {
      status: 400,
      details: { field: `nodes[${index}].nodeRole` },
    });
  }

  return value as DashboardWorkflowDraftNode['nodeRole'];
}

function parseDraftNodeMaxChildren(value: unknown, index: number): number {
  if (value === undefined || value === null) {
    return 12;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Draft node at index ${index} has an invalid maxChildren.`,
      {
        status: 400,
        details: { field: `nodes[${index}].maxChildren` },
      },
    );
  }

  return value;
}

function parseDraftNodePromptTemplate(
  value: unknown,
  index: number,
): { content: string; contentType: 'text' | 'markdown' } | null {
  if (value === null) {
    return null;
  }

  if (
    isRecord(value) &&
    typeof value.content === 'string' &&
    (value.contentType === 'text' || value.contentType === 'markdown')
  ) {
    return { content: value.content, contentType: value.contentType };
  }

  throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid promptTemplate.`, {
    status: 400,
    details: { field: `nodes[${index}].promptTemplate` },
  });
}

function parseDraftNodeExecutionPermissions(value: unknown, index: number): ProviderExecutionPermissions | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throwInvalidExecutionPermissions(index);
  }

  assertSupportedExecutionPermissionKeys(value, index);

  const parsed: ProviderExecutionPermissions = {};
  const approvalPolicy = parseExecutionPermissionApprovalPolicy(value, index);
  if (approvalPolicy !== undefined) {
    parsed.approvalPolicy = approvalPolicy;
  }

  const sandboxMode = parseExecutionPermissionSandboxMode(value, index);
  if (sandboxMode !== undefined) {
    parsed.sandboxMode = sandboxMode;
  }

  const networkAccessEnabled = parseExecutionPermissionNetworkAccessEnabled(value, index);
  if (networkAccessEnabled !== undefined) {
    parsed.networkAccessEnabled = networkAccessEnabled;
  }

  const additionalDirectories = parseExecutionPermissionAdditionalDirectories(value, index);
  if (additionalDirectories !== undefined) {
    parsed.additionalDirectories = additionalDirectories;
  }

  const webSearchMode = parseExecutionPermissionWebSearchMode(value, index);
  if (webSearchMode !== undefined) {
    parsed.webSearchMode = webSearchMode;
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseDraftNode(raw: unknown, index: number): DashboardWorkflowDraftNode {
  if (!isRecord(raw)) {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} must be an object.`, {
      status: 400,
      details: { field: `nodes[${index}]` },
    });
  }

  const nodeType = raw.nodeType;
  if (nodeType !== 'agent' && nodeType !== 'human' && nodeType !== 'tool') {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid nodeType.`, {
      status: 400,
      details: { field: `nodes[${index}].nodeType` },
    });
  }

  const provider = raw.provider;
  if (provider !== null && typeof provider !== 'string') {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid provider.`, {
      status: 400,
      details: { field: `nodes[${index}].provider` },
    });
  }

  const model = raw.model ?? null;
  if (model !== null && typeof model !== 'string') {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid model.`, {
      status: 400,
      details: { field: `nodes[${index}].model` },
    });
  }

  const position = parseDraftNodePosition(raw.position, index);
  const nodeRole = parseDraftNodeRole(raw.nodeRole, index);
  const maxChildren = parseDraftNodeMaxChildren(raw.maxChildren, index);
  const promptTemplate = parseDraftNodePromptTemplate(raw.promptTemplate, index);
  const executionPermissions = parseDraftNodeExecutionPermissions(raw.executionPermissions, index);

  if (typeof raw.nodeKey !== 'string' || typeof raw.displayName !== 'string') {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} must have nodeKey and displayName strings.`, {
      status: 400,
      details: { field: `nodes[${index}]` },
    });
  }

  if (typeof raw.maxRetries !== 'number' || !Number.isInteger(raw.maxRetries) || raw.maxRetries < 0) {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid maxRetries.`, {
      status: 400,
      details: { field: `nodes[${index}].maxRetries` },
    });
  }

  if (typeof raw.sequenceIndex !== 'number' || !Number.isInteger(raw.sequenceIndex) || raw.sequenceIndex < 0) {
    throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid sequenceIndex.`, {
      status: 400,
      details: { field: `nodes[${index}].sequenceIndex` },
    });
  }

  return {
    nodeKey: raw.nodeKey,
    displayName: raw.displayName,
    nodeType,
    nodeRole,
    maxChildren,
    provider,
    model,
    ...(executionPermissions === null ? {} : { executionPermissions }),
    maxRetries: raw.maxRetries,
    sequenceIndex: raw.sequenceIndex,
    position,
    promptTemplate,
  };
}

function parseDraftEdge(raw: unknown, index: number): DashboardWorkflowDraftEdge {
  if (!isRecord(raw)) {
    throw new DashboardIntegrationError('invalid_request', `Draft edge at index ${index} must be an object.`, {
      status: 400,
      details: { field: `edges[${index}]` },
    });
  }

  if (typeof raw.sourceNodeKey !== 'string' || typeof raw.targetNodeKey !== 'string') {
    throw new DashboardIntegrationError('invalid_request', `Draft edge at index ${index} must have string node keys.`, {
      status: 400,
      details: { field: `edges[${index}]` },
    });
  }

  if (typeof raw.priority !== 'number' || !Number.isInteger(raw.priority)) {
    throw new DashboardIntegrationError('invalid_request', `Draft edge at index ${index} must have an integer priority.`, {
      status: 400,
      details: { field: `edges[${index}].priority` },
    });
  }

  if (typeof raw.auto !== 'boolean') {
    throw new DashboardIntegrationError('invalid_request', `Draft edge at index ${index} must have a boolean auto flag.`, {
      status: 400,
      details: { field: `edges[${index}].auto` },
    });
  }

  const guardExpression = parseDraftEdgeGuardExpression(raw.guardExpression, index);
  const routeOn = parseDraftEdgeRouteOn(raw.routeOn, index);

  if (routeOn === 'failure') {
    if (raw.auto !== true) {
      throw new DashboardIntegrationError(
        'invalid_request',
        `Draft edge at index ${index} with routeOn="failure" must set auto=true.`,
        {
          status: 400,
          details: { field: `edges[${index}].auto` },
        },
      );
    }

    if (guardExpression !== null) {
      throw new DashboardIntegrationError(
        'invalid_request',
        `Draft edge at index ${index} with routeOn="failure" must not include guardExpression.`,
        {
          status: 400,
          details: { field: `edges[${index}].guardExpression` },
        },
      );
    }
  }

  return {
    sourceNodeKey: raw.sourceNodeKey,
    targetNodeKey: raw.targetNodeKey,
    routeOn,
    priority: raw.priority,
    auto: raw.auto,
    guardExpression,
  };
}

function parseSaveWorkflowDraftRequest(payload: unknown): DashboardSaveWorkflowDraftRequest {
  const record = requireRecord(payload, 'Draft save payload must be a JSON object.');

  const draftRevision = record.draftRevision;
  if (typeof draftRevision !== 'number' || !Number.isInteger(draftRevision) || draftRevision < 1) {
    throw new DashboardIntegrationError('invalid_request', 'Draft revision must be a positive integer.', {
      status: 400,
      details: { field: 'draftRevision' },
    });
  }

  if (typeof record.name !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Draft name must be a string.', {
      status: 400,
      details: { field: 'name' },
    });
  }

  const description = optionalStringField(record, 'description', 'Draft description must be a string when provided.');

  const versionNotes = optionalStringField(record, 'versionNotes', 'Draft versionNotes must be a string when provided.');

  if (!Array.isArray(record.nodes)) {
    throw new DashboardIntegrationError('invalid_request', 'Draft nodes must be an array.', { status: 400, details: { field: 'nodes' } });
  }
  if (!Array.isArray(record.edges)) {
    throw new DashboardIntegrationError('invalid_request', 'Draft edges must be an array.', { status: 400, details: { field: 'edges' } });
  }

  const nodes: DashboardWorkflowDraftNode[] = record.nodes.map((raw, index) => parseDraftNode(raw, index));

  const edges: DashboardWorkflowDraftEdge[] = record.edges.map((raw, index) => parseDraftEdge(raw, index));

  return {
    draftRevision,
    name: record.name,
    ...(description === undefined ? {} : { description }),
    ...(versionNotes === undefined ? {} : { versionNotes }),
    nodes,
    edges,
  };
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const draft = await service.getOrCreateWorkflowDraft(params.treeKey);
    return NextResponse.json({ draft });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const version = parsePositiveIntegerQueryParam(
      request,
      'version',
      'Query parameter "version" must be a positive integer.',
    );
    const payload = parseSaveWorkflowDraftRequest(await request.json());
    const draft = await service.saveWorkflowDraft(params.treeKey, version, payload);
    return NextResponse.json({ draft });
  } catch (error) {
    return toErrorResponse(error);
  }
}
