import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../../src/server/dashboard-http';
import type { DashboardPublishWorkflowDraftRequest } from '../../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../../../../src/server/dashboard-service';
import { parsePositiveIntegerQueryParam, requireRecord } from '../../../_shared/validation';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

function parsePublishWorkflowDraftRequest(payload: unknown): DashboardPublishWorkflowDraftRequest {
  const record = requireRecord(payload, 'Publish payload must be a JSON object.');

  if (record.versionNotes !== undefined && typeof record.versionNotes !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Publish versionNotes must be a string when provided.', {
      status: 400,
      details: { field: 'versionNotes' },
    });
  }

  return record.versionNotes === undefined ? {} : { versionNotes: record.versionNotes as string };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const version = parsePositiveIntegerQueryParam(
      request,
      'version',
      'Query parameter "version" must be a positive integer.',
    );
    const payload = parsePublishWorkflowDraftRequest(await request.json().catch(() => ({})));
    const workflow = await service.publishWorkflowDraft(params.treeKey, version, payload);
    return NextResponse.json({ workflow });
  } catch (error) {
    return toErrorResponse(error);
  }
}
