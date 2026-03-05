import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { parseJsonObjectBody, parseWorkItemIdFromPathSegment } from '../../../_shared/work-item-route-validation';

export type WorkItemActionRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function resolveWorkItemId(context: WorkItemActionRouteContext): Promise<number> {
  const params = await context.params;
  return parseWorkItemIdFromPathSegment(params.id);
}

export async function handleWorkItemActionPost<TRequest, TResult>(params: {
  request: Request;
  context: WorkItemActionRouteContext;
  invalidJsonMessage: string;
  objectMessage: string;
  parseRequest: (payload: Record<string, unknown>, workItemId: number) => TRequest;
  execute: (service: ReturnType<typeof createDashboardService>, request: TRequest) => Promise<TResult>;
}): Promise<Response> {
  const service = createDashboardService();

  try {
    const workItemId = await resolveWorkItemId(params.context);
    const payload = await parseJsonObjectBody(params.request, {
      invalidJsonMessage: params.invalidJsonMessage,
      objectMessage: params.objectMessage,
    });
    const request = params.parseRequest(payload, workItemId);
    const result = await params.execute(service, request);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
