import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../src/server/dashboard-service';

export async function GET(): Promise<Response> {
  const service = createDashboardService();

  try {
    const workflows = await service.listWorkflowTrees();
    return NextResponse.json({ workflows });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const payload = await request.json();
    const workflow = await service.createWorkflowDraft(payload);
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
