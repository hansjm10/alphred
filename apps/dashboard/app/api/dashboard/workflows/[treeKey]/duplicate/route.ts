import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import type { DashboardDuplicateWorkflowRequest } from '../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../src/server/dashboard-errors';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDuplicateWorkflowRequest(payload: unknown): DashboardDuplicateWorkflowRequest {
  if (!isRecord(payload)) {
    throw new DashboardIntegrationError('invalid_request', 'Workflow duplicate payload must be a JSON object.', {
      status: 400,
    });
  }

  if (typeof payload.name !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow name must be a string.', {
      status: 400,
      details: { field: 'name' },
    });
  }

  if (typeof payload.treeKey !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Workflow treeKey must be a string.', {
      status: 400,
      details: { field: 'treeKey' },
    });
  }

  const description =
    payload.description === undefined
      ? undefined
      : typeof payload.description === 'string'
        ? payload.description
        : (() => {
            throw new DashboardIntegrationError(
              'invalid_request',
              'Workflow description must be a string when provided.',
              { status: 400, details: { field: 'description' } },
            );
          })();

  return {
    name: payload.name,
    treeKey: payload.treeKey,
    ...(description === undefined ? {} : { description }),
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const payload = parseDuplicateWorkflowRequest(await request.json());
    const workflow = await service.duplicateWorkflowTree(params.treeKey, payload);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
