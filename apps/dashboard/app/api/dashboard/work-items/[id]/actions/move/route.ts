import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseJsonObjectBody,
  parseMoveWorkItemStatusRequest,
  parseWorkItemIdFromPathSegment,
} from '../../../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveWorkItemId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const workItemId = await resolveWorkItemId(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item move payload must be valid JSON.',
      objectMessage: 'Work item move payload must be a JSON object.',
    });
    const moveRequest = parseMoveWorkItemStatusRequest(payload, workItemId);
    const result = await service.moveWorkItemStatus(moveRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
