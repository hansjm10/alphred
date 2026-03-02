import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../../src/server/dashboard-service';
import {
  parseApproveStoryBreakdownRequest,
  parseJsonObjectBody,
  parseWorkItemIdFromPathSegment,
} from '../../../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveStoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const storyId = await resolveStoryId(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item breakdown approval payload must be valid JSON.',
      objectMessage: 'Work item breakdown approval payload must be a JSON object.',
    });
    const approveRequest = parseApproveStoryBreakdownRequest(payload, storyId);
    const result = await service.approveStoryBreakdown(approveRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
