import { DashboardIntegrationError } from '../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../src/server/dashboard-http';
import { createDashboardService, type DashboardService } from '../../../../../src/server/dashboard-service';

export type RunIdRouteContext = {
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

async function resolveRunId(context: RunIdRouteContext): Promise<number> {
  const params = await context.params;
  return parseRunId(params.runId);
}

export async function withRunIdRoute(
  context: RunIdRouteContext,
  respond: (service: DashboardService, runId: number) => Promise<Response>,
): Promise<Response> {
  const service = createDashboardService();

  try {
    const runId = await resolveRunId(context);
    return await respond(service, runId);
  } catch (error) {
    return toErrorResponse(error);
  }
}
