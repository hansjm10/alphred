import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseRepositoryIdFromQuery,
  parseRunIdFromPathSegment,
  parseWorkItemIdFromPathSegment,
} from '../../../../_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    id: string;
    runId: string;
  }>;
};

async function resolveRouteParams(context: RouteContext): Promise<{ storyId: number; workflowRunId: number }> {
  const params = await context.params;
  return {
    storyId: parseWorkItemIdFromPathSegment(params.id),
    workflowRunId: parseRunIdFromPathSegment(params.runId),
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = parseRepositoryIdFromQuery(request);
    const { storyId, workflowRunId } = await resolveRouteParams(context);
    const result = await service.getStoryBreakdownRun({
      repositoryId,
      storyId,
      workflowRunId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
