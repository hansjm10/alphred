import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../src/server/dashboard-service';

export async function GET(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const url = new URL(request.url);
    const treeKey = url.searchParams.get('treeKey');
    if (treeKey !== null) {
      const availability = await service.isWorkflowTreeKeyAvailable(treeKey);
      return NextResponse.json(availability);
    }

    const workflows = await service.listWorkflowCatalog();
    return NextResponse.json({ workflows });
  } catch (error) {
    return toErrorResponse(error);
  }
}
