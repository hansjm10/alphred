import { NextResponse } from 'next/server';
import { withRunIdRoute, type RunIdRouteContext } from './run-id-route';

export async function GET(_request: Request, context: RunIdRouteContext): Promise<Response> {
  return withRunIdRoute(context, async (service, runId) => {
    const detail = await service.getWorkflowRunDetail(runId);
    return NextResponse.json(detail);
  });
}
