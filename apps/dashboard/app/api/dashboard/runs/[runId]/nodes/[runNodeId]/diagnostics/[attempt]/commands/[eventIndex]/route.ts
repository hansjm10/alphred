import { NextResponse } from 'next/server';
import { DashboardIntegrationError } from '../../../../../../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../../../../../../src/server/dashboard-service';

type RunNodeDiagnosticCommandRouteContext = {
  params: Promise<{
    runId: string;
    runNodeId: string;
    attempt: string;
    eventIndex: string;
  }>;
};

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', `${name} must be a positive integer.`, {
      status: 400,
    });
  }

  return parsed;
}

function parseNonNegativeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DashboardIntegrationError('invalid_request', `${name} must be a non-negative integer.`, {
      status: 400,
    });
  }

  return parsed;
}

export async function GET(_request: Request, context: RunNodeDiagnosticCommandRouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const runId = parsePositiveInteger('runId', params.runId);
    const runNodeId = parsePositiveInteger('runNodeId', params.runNodeId);
    const attempt = parsePositiveInteger('attempt', params.attempt);
    const eventIndex = parseNonNegativeInteger('eventIndex', params.eventIndex);
    const output = await service.getRunNodeDiagnosticCommandOutput({
      runId,
      runNodeId,
      attempt,
      eventIndex,
    });
    return NextResponse.json(output);
  } catch (error) {
    return toErrorResponse(error);
  }
}
