import { NextResponse } from 'next/server';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../src/server/dashboard-service';

export async function GET(): Promise<Response> {
  const service = createDashboardService();

  try {
    const repositories = await service.listRepositories();
    return NextResponse.json({ repositories });
  } catch (error) {
    return toErrorResponse(error);
  }
}
