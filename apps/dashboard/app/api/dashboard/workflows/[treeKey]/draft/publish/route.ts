import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../../src/server/dashboard-http';
import type { DashboardPublishWorkflowDraftRequest } from '../../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../../../../src/server/dashboard-service';

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

function parsePublishWorkflowDraftRequest(payload: unknown): DashboardPublishWorkflowDraftRequest {
  if (!isRecord(payload)) {
    throw new DashboardIntegrationError('invalid_request', 'Publish payload must be a JSON object.', { status: 400 });
  }

  if (payload.versionNotes !== undefined && typeof payload.versionNotes !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Publish versionNotes must be a string when provided.', {
      status: 400,
      details: { field: 'versionNotes' },
    });
  }

  return payload.versionNotes === undefined ? {} : { versionNotes: payload.versionNotes };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const version = parseVersionParam(request);
    const payload = parsePublishWorkflowDraftRequest(await request.json().catch(() => ({})));
    const workflow = await service.publishWorkflowDraft(params.treeKey, version, payload);
    return NextResponse.json({ workflow });
  } catch (error) {
    return toErrorResponse(error);
  }
}
