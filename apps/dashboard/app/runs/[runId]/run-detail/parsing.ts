import type {
  DashboardRunControlAction,
  DashboardRunControlResult,
  DashboardRunDetail,
  DashboardRunNodeStreamSnapshot,
  DashboardRunSummary,
} from '../../../../src/server/dashboard-contracts';
import { RUN_CONTROL_ACTIONS, RUN_CONTROL_OUTCOMES, RUN_STATUSES, type ErrorEnvelope } from './types';
import {
  hasRunNodeStreamSnapshotShape,
  hasRunSummaryShape,
  hasRunNodeShape,
  hasArtifactShape,
  hasRoutingDecisionShape,
  hasDiagnosticsShape,
  hasWorktreeShape,
  isRecord,
  isInteger,
} from './validation';

export function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ErrorEnvelope).error === 'object' &&
    (payload as ErrorEnvelope).error !== null &&
    typeof (payload as ErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

export function parseRunDetailPayload(payload: unknown, expectedRunId: number): DashboardRunDetail | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (!hasRunSummaryShape(payload.run, expectedRunId)) {
    return null;
  }

  if (!Array.isArray(payload.nodes) || !payload.nodes.every((node) => hasRunNodeShape(node))) {
    return null;
  }

  if (!Array.isArray(payload.artifacts) || !payload.artifacts.every((artifact) => hasArtifactShape(artifact))) {
    return null;
  }

  if (
    !Array.isArray(payload.routingDecisions) ||
    !payload.routingDecisions.every((decision) => hasRoutingDecisionShape(decision))
  ) {
    return null;
  }

  if (!Array.isArray(payload.diagnostics) || !payload.diagnostics.every((diagnostics) => hasDiagnosticsShape(diagnostics))) {
    return null;
  }

  if (!Array.isArray(payload.worktrees) || !payload.worktrees.every((worktree) => hasWorktreeShape(worktree, expectedRunId))) {
    return null;
  }

  return payload as DashboardRunDetail;
}

export function parseRunControlPayload(payload: unknown, expectedRunId: number): DashboardRunControlResult | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    typeof payload.action !== 'string' ||
    !RUN_CONTROL_ACTIONS.has(payload.action as DashboardRunControlAction) ||
    typeof payload.outcome !== 'string' ||
    !RUN_CONTROL_OUTCOMES.has(payload.outcome as DashboardRunControlResult['outcome']) ||
    !isInteger(payload.workflowRunId) ||
    payload.workflowRunId !== expectedRunId ||
    typeof payload.previousRunStatus !== 'string' ||
    !RUN_STATUSES.has(payload.previousRunStatus as DashboardRunSummary['status']) ||
    typeof payload.runStatus !== 'string' ||
    !RUN_STATUSES.has(payload.runStatus as DashboardRunSummary['status']) ||
    !Array.isArray(payload.retriedRunNodeIds) ||
    !payload.retriedRunNodeIds.every(isInteger)
  ) {
    return null;
  }

  return payload as DashboardRunControlResult;
}

export async function fetchRunDetailSnapshot(
  runId: number,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<DashboardRunDetail> {
  const response = await fetch(`/api/dashboard/runs/${runId}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
    signal: options.signal,
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh run timeline'));
  }

  const parsedDetail = parseRunDetailPayload(payload, runId);
  if (parsedDetail === null) {
    throw new Error('Realtime run detail response was malformed.');
  }

  return parsedDetail;
}

export function parseRunNodeStreamSnapshotPayload(
  payload: unknown,
  expectedRunId: number,
  expectedRunNodeId: number,
  expectedAttempt: number,
): DashboardRunNodeStreamSnapshot | null {
  if (!hasRunNodeStreamSnapshotShape(payload, expectedRunId, expectedRunNodeId, expectedAttempt)) {
    return null;
  }

  return payload;
}
