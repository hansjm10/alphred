import { NextResponse } from 'next/server';
import type { DashboardRunControlAction } from '../../../../../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../../../../../src/server/dashboard-errors';
import { withRunIdRoute, type RunIdRouteContext } from '../../run-id-route';

type RunActionRouteContext = RunIdRouteContext & {
  params: Promise<{
    runId: string;
    action: string;
  }>;
};

const RUN_CONTROL_ACTIONS = new Set<DashboardRunControlAction>(['cancel', 'pause', 'resume', 'retry']);

function parseRunControlAction(value: string): DashboardRunControlAction {
  const normalized = value.trim().toLowerCase();
  if (RUN_CONTROL_ACTIONS.has(normalized as DashboardRunControlAction)) {
    return normalized as DashboardRunControlAction;
  }

  throw new DashboardIntegrationError('invalid_request', 'action must be one of: cancel, pause, resume, retry.', {
    status: 400,
  });
}

export async function POST(_request: Request, context: RunActionRouteContext): Promise<Response> {
  return withRunIdRoute(context, async (service, runId) => {
    const params = await context.params;
    const action = parseRunControlAction(params.action);
    const result = await service.controlWorkflowRun(runId, action);
    return NextResponse.json(result);
  });
}
