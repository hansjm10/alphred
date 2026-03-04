import { NextResponse } from 'next/server';
import type { DashboardRunControlAction } from '@dashboard/server/dashboard-contracts';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';
import { withRunIdRoute, type RunIdRouteContext } from '../../run-id-route';

type RunActionRouteContext = RunIdRouteContext & {
  params: Promise<{
    runId: string;
    action: string;
  }>;
};

const RUN_CONTROL_ACTIONS = new Set<DashboardRunControlAction>(['cancel', 'pause', 'resume', 'retry']);
const RUN_WORKTREE_CLEANUP_ACTION = 'cleanup-worktree';

type ParsedRunAction =
  | {
      kind: 'control';
      action: DashboardRunControlAction;
    }
  | {
      kind: 'cleanup_worktree';
    };

function parseRunAction(value: string): ParsedRunAction {
  const normalized = value.trim().toLowerCase();
  if (RUN_CONTROL_ACTIONS.has(normalized as DashboardRunControlAction)) {
    return {
      kind: 'control',
      action: normalized as DashboardRunControlAction,
    };
  }

  if (normalized === RUN_WORKTREE_CLEANUP_ACTION) {
    return {
      kind: 'cleanup_worktree',
    };
  }

  throw new DashboardIntegrationError(
    'invalid_request',
    'action must be one of: cancel, pause, resume, retry, cleanup-worktree.',
    {
      status: 400,
    },
  );
}

export async function POST(_request: Request, context: RunActionRouteContext): Promise<Response> {
  return withRunIdRoute(context, async (service, runId) => {
    const params = await context.params;
    const action = parseRunAction(params.action);
    const result =
      action.kind === 'cleanup_worktree'
        ? await service.cleanupRunWorktree(runId)
        : await service.controlWorkflowRun(runId, action.action);
    return NextResponse.json(result);
  });
}
