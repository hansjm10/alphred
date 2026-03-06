import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseJsonObjectBody,
  parseLaunchStoryBreakdownRunRequest,
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
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Breakdown run launch payload must be valid JSON.',
      objectMessage: 'Breakdown run launch payload must be a JSON object.',
    });
    const storyId = await resolveStoryId(context);
    const launchRequest = parseLaunchStoryBreakdownRunRequest(payload, storyId);
    const result = await service.launchStoryBreakdownRun(launchRequest);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
