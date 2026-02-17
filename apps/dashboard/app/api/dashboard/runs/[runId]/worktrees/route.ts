import { NextResponse } from 'next/server';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

function parseRunId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', 'runId must be a positive integer.', {
      status: 400,
    });
  }

  return parsed;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const runId = parseRunId(params.runId);
    const worktrees = await service.getRunWorktrees(runId);
    return NextResponse.json({ worktrees });
  } catch (error) {
    return toErrorResponse(error);
  }
}
