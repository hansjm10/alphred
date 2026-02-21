import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
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
    const payload = await request.json();
    const draft = await service.saveWorkflowDraft(params.treeKey, version, payload);
    return NextResponse.json({ draft });
  } catch (error) {
    return toErrorResponse(error);
  }
}
