import { NextResponse } from 'next/server';
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

  const position = parseDraftNodePosition(raw.position, index);
  const promptTemplate = parseDraftNodePromptTemplate(raw.promptTemplate, index);

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
    provider,
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

  const guardExpression = raw.guardExpression;

  return {
    sourceNodeKey: raw.sourceNodeKey,
    targetNodeKey: raw.targetNodeKey,
    priority: raw.priority,
    auto: raw.auto,
    guardExpression: guardExpression === undefined ? null : guardExpression,
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
