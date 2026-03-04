import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseJsonObjectBody,
  parseRepositoryIdFromPathSegment,
  parseRequestWorkItemReplanRequest,
  parseWorkItemIdFromPathSegment,
} from '../../../../../../work-items/_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    name: string;
    id: string;
  }>;
};

async function resolveIds(context: RouteContext): Promise<{ repositoryId: number; workItemId: number }> {
  const params = await context.params;
  return {
    repositoryId: parseRepositoryIdFromPathSegment(params.name),
    workItemId: parseWorkItemIdFromPathSegment(params.id),
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const { repositoryId, workItemId } = await resolveIds(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item replan payload must be valid JSON.',
      objectMessage: 'Work item replan payload must be a JSON object.',
    });
    const replanRequest = parseRequestWorkItemReplanRequest(payload, repositoryId, workItemId);
    const result = await service.requestWorkItemReplan(replanRequest);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
