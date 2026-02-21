import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import type {
  DashboardSaveWorkflowDraftRequest,
  DashboardWorkflowDraftEdge,
  DashboardWorkflowDraftNode,
} from '../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

function parseVersionParam(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get('version');
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', 'Query parameter "version" must be a positive integer.', {
      status: 400,
    });
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSaveWorkflowDraftRequest(payload: unknown): DashboardSaveWorkflowDraftRequest {
  if (!isRecord(payload)) {
    throw new DashboardIntegrationError('invalid_request', 'Draft save payload must be a JSON object.', { status: 400 });
  }

  const draftRevision = payload.draftRevision;
  if (typeof draftRevision !== 'number' || !Number.isInteger(draftRevision) || draftRevision < 1) {
    throw new DashboardIntegrationError('invalid_request', 'Draft revision must be a positive integer.', {
      status: 400,
      details: { field: 'draftRevision' },
    });
  }

  if (typeof payload.name !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Draft name must be a string.', {
      status: 400,
      details: { field: 'name' },
    });
  }

  const description =
    payload.description === undefined
      ? undefined
      : typeof payload.description === 'string'
        ? payload.description
        : (() => {
            throw new DashboardIntegrationError('invalid_request', 'Draft description must be a string when provided.', {
              status: 400,
              details: { field: 'description' },
            });
          })();

  const versionNotes =
    payload.versionNotes === undefined
      ? undefined
      : typeof payload.versionNotes === 'string'
        ? payload.versionNotes
        : (() => {
            throw new DashboardIntegrationError('invalid_request', 'Draft versionNotes must be a string when provided.', {
              status: 400,
              details: { field: 'versionNotes' },
            });
          })();

  if (!Array.isArray(payload.nodes)) {
    throw new DashboardIntegrationError('invalid_request', 'Draft nodes must be an array.', { status: 400, details: { field: 'nodes' } });
  }
  if (!Array.isArray(payload.edges)) {
    throw new DashboardIntegrationError('invalid_request', 'Draft edges must be an array.', { status: 400, details: { field: 'edges' } });
  }

  const nodes: DashboardWorkflowDraftNode[] = payload.nodes.map((raw, index) => {
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

    const position = raw.position;
    if (
      position !== null &&
      !(
        isRecord(position) &&
        typeof position.x === 'number' &&
        Number.isFinite(position.x) &&
        typeof position.y === 'number' &&
        Number.isFinite(position.y)
      )
    ) {
      throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid position.`, {
        status: 400,
        details: { field: `nodes[${index}].position` },
      });
    }

    const promptTemplate = raw.promptTemplate;
    if (
      promptTemplate !== null &&
      !(
        isRecord(promptTemplate) &&
        typeof promptTemplate.content === 'string' &&
        (promptTemplate.contentType === 'text' || promptTemplate.contentType === 'markdown')
      )
    ) {
      throw new DashboardIntegrationError('invalid_request', `Draft node at index ${index} has an invalid promptTemplate.`, {
        status: 400,
        details: { field: `nodes[${index}].promptTemplate` },
      });
    }

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
    if (typeof raw.sequenceIndex !== 'number' || !Number.isInteger(raw.sequenceIndex)) {
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
      position: position === null ? null : { x: position.x as number, y: position.y as number },
      promptTemplate:
        promptTemplate === null
          ? null
          : { content: promptTemplate.content as string, contentType: promptTemplate.contentType as 'text' | 'markdown' },
    };
  });

  const edges: DashboardWorkflowDraftEdge[] = payload.edges.map((raw, index) => {
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

    const guardExpression = 'guardExpression' in raw ? raw.guardExpression : null;

    return {
      sourceNodeKey: raw.sourceNodeKey,
      targetNodeKey: raw.targetNodeKey,
      priority: raw.priority,
      auto: raw.auto,
      guardExpression: guardExpression === undefined ? null : (guardExpression as unknown),
    };
  });

  return {
    draftRevision,
    name: payload.name,
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
    const version = parseVersionParam(request);
    const payload = parseSaveWorkflowDraftRequest(await request.json());
    const draft = await service.saveWorkflowDraft(params.treeKey, version, payload);
    return NextResponse.json({ draft });
  } catch (error) {
    return toErrorResponse(error);
  }
}
