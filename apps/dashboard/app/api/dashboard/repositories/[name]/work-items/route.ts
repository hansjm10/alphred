import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import {
  parseCreateWorkItemRequest,
  parseJsonObjectBody,
  parseRepositoryIdFromPathSegment,
} from '../../../work-items/_shared/work-item-route-validation';

type RouteContext = {
  params: Promise<{
    name: string;
  }>;
};

async function resolveRepositoryId(context: RouteContext): Promise<number> {
  const params = await context.params;
  return parseRepositoryIdFromPathSegment(params.name);
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = await resolveRepositoryId(context);
    const result = await service.listWorkItems(repositoryId);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositoryId = await resolveRepositoryId(context);
    const payload = await parseJsonObjectBody(request, {
      invalidJsonMessage: 'Work item create payload must be valid JSON.',
      objectMessage: 'Work item create payload must be a JSON object.',
    });
    const createRequest = parseCreateWorkItemRequest(payload, repositoryId);
    const result = await service.createWorkItem(createRequest);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
