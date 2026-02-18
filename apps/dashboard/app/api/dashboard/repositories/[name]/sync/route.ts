import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    name: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const result = await service.syncRepository(params.name);
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
