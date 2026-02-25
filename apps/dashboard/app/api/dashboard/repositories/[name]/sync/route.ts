import { NextResponse } from 'next/server';
import type {
  DashboardRepositorySyncRequest,
  DashboardRepositorySyncStrategy,
} from '../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    name: string;
  }>;
};

const allowedSyncStrategies = new Set<DashboardRepositorySyncStrategy>(['ff-only', 'merge', 'rebase']);

function parseSyncRequest(payload: unknown): DashboardRepositorySyncRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new DashboardIntegrationError('invalid_request', 'Repository sync request body must be an object.', {
      status: 400,
    });
  }

  const candidate = payload as Record<string, unknown>;
  const strategyValue = candidate.strategy;
  if (strategyValue !== undefined) {
    if (typeof strategyValue !== 'string') {
      throw new DashboardIntegrationError('invalid_request', 'Field "strategy" must be a string when provided.', {
        status: 400,
      });
    }

    if (!allowedSyncStrategies.has(strategyValue as DashboardRepositorySyncStrategy)) {
      throw new DashboardIntegrationError(
        'invalid_request',
        'Field "strategy" must be one of: ff-only, merge, rebase.',
        {
          status: 400,
        },
      );
    }
  }

  return {
    strategy: strategyValue as DashboardRepositorySyncStrategy | undefined,
  };
}

async function parseSyncRequestBody(request: Request): Promise<DashboardRepositorySyncRequest> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) {
    return {};
  }

  try {
    return parseSyncRequest(JSON.parse(rawBody) as unknown);
  } catch (error) {
    if (error instanceof DashboardIntegrationError) {
      throw error;
    }

    throw new DashboardIntegrationError('invalid_request', 'Repository sync payload must be valid JSON.', {
      status: 400,
      cause: error,
    });
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const syncRequest = await parseSyncRequestBody(request);
    const result = await service.syncRepository(params.name, syncRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
