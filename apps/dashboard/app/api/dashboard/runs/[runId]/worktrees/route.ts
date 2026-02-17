import { NextResponse } from 'next/server';
import { withRunIdRoute, type RunIdRouteContext } from '../run-id-route';

export async function GET(_request: Request, context: RunIdRouteContext): Promise<Response> {
  return withRunIdRoute(context, async (service, runId) => {
    const worktrees = await service.getRunWorktrees(runId);
    return NextResponse.json({ worktrees });
  });
}
