import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../../src/server/dashboard-service';

type RouteContext = {
  params: Promise<{
    treeKey: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const service = createDashboardService();

  try {
    const params = await context.params;
    const nodes = await service.listPublishedTreeNodes(params.treeKey);
    return NextResponse.json({ nodes });
  } catch (error) {
    return toErrorResponse(error);
  }
}
