import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';
import { parseRepositoryIdFromQuery, parseWorkItemIdFromPathSegment } from '../../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveStoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = parseRepositoryIdFromQuery(request);
    const storyId = await resolveStoryId(context);
    const result = await service.getStoryBreakdownProposal({ repositoryId, storyId });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
