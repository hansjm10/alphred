import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseCreateStoryWorkspaceRequest,
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
      invalidJsonMessage: 'Story workspace payload must be valid JSON.',
      objectMessage: 'Story workspace payload must be a JSON object.',
    });
    const createRequest = parseCreateStoryWorkspaceRequest(payload, storyId);
    const result = await service.createStoryWorkspace(createRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
