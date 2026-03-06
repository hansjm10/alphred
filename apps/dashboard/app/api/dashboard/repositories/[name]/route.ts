import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { parseRepositoryIdFromPathSegment } from '../../work-items/_shared/work-item-route-validation';

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
    const result = await service.getRepository({
      repositoryId,
      includeArchived: true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
