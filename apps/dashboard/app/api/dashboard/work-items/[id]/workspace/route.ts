import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseRepositoryIdFromQuery,
  parseWorkItemIdFromPathSegment,
} from '../../_shared/work-item-route-validation';

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
    const storyId = await resolveWorkItemId(context);
    const result = await service.getStoryWorkspace({ repositoryId, storyId });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
