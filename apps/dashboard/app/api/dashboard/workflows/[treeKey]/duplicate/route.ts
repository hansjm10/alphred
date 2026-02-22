import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import type { DashboardDuplicateWorkflowRequest } from '../../../../../../src/server/dashboard-contracts';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';
import { optionalStringField, requireRecord, requireStringField } from '../../_shared/validation';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

function parseDuplicateWorkflowRequest(payload: unknown): DashboardDuplicateWorkflowRequest {
  const record = requireRecord(payload, 'Workflow duplicate payload must be a JSON object.');
  const name = requireStringField(record, 'name', 'Workflow name must be a string.');
  const treeKey = requireStringField(record, 'treeKey', 'Workflow treeKey must be a string.');
  const description = optionalStringField(record, 'description', 'Workflow description must be a string when provided.');

  return {
    name,
    treeKey,
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
