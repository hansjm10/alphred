import { NextResponse } from 'next/server';
import { toErrorResponse } from '@dashboard/server/dashboard-http';
import { createDashboardService } from '@dashboard/server/dashboard-service';

export async function POST(): Promise<Response> {
  const service = createDashboardService();

  try {
    const auth = await service.checkGitHubAuth();
    return NextResponse.json(auth);
  } catch (error) {
    return toErrorResponse(error);
  }
}
