import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../../src/server/dashboard-service';

export async function GET(): Promise<Response> {
  const service = createDashboardService();

  try {
    const workflows = await service.listWorkflowCatalog();
    return NextResponse.json({ workflows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

