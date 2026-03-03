import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseJsonObjectBody,
  parseRepositoryIdFromQuery,
  parseUpdateWorkItemFieldsRequest,
  parseWorkItemIdFromPathSegment,
} from '../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveWorkItemId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = parseRepositoryIdFromQuery(request);
    const workItemId = await resolveWorkItemId(context);
    const result = await service.getWorkItem({ repositoryId, workItemId });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const workItemId = await resolveWorkItemId(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item update payload must be valid JSON.',
      objectMessage: 'Work item update payload must be a JSON object.',
    });
    const updateRequest = parseUpdateWorkItemFieldsRequest(payload, workItemId);
    const result = await service.updateWorkItemFields(updateRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
