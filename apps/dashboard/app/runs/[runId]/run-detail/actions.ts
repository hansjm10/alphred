import { isActiveRunStatus } from '../../run-summary-utils';
import type {
  DashboardRunControlResult,
  DashboardRunDetail,
  DashboardRunSummary,
  DashboardRunWorktreeCleanupResult,
} from '@dashboard/server/dashboard-contracts';
import type {
  ActionFeedbackState,
  DashboardRunOperatorAction,
  ExecuteRunControlActionParams,
  OperatorActionState,
  OperatorActionSet,
  RealtimeChannelState,
  StateSetter,
} from './types';
import {
  fetchRunDetailSnapshot,
  parseRunControlPayload,
  parseRunWorktreeCleanupPayload,
  resolveApiErrorMessage,
} from './parsing';

export function resolveOperatorActions(
  run: DashboardRunSummary,
  hasWorktree: boolean,
  hasActiveWorktree: boolean,
): OperatorActionSet {
  const cleanupWorktreeAction: OperatorActionState | null = hasActiveWorktree
    ? {
        label: 'Clean up worktree',
        href: null,
        controlAction: 'cleanup-worktree',
        disabledReason: null,
      }
    : null;

  if (run.status === 'completed') {
    if (hasWorktree) {
      return {
        primary: {
          label: 'Open Worktree',
          href: `/runs/${run.id}/worktree`,
          controlAction: null,
          disabledReason: null,
        },
        secondary: cleanupWorktreeAction,
      };
    }

    return {
      primary: {
        label: 'Open Worktree',
        href: null,
        controlAction: null,
        disabledReason: 'No worktree was captured for this run.',
      },
      secondary: cleanupWorktreeAction,
    };
  }

  if (run.status === 'running') {
    return {
      primary: {
        label: 'Pause',
        href: null,
        controlAction: 'pause',
        disabledReason: null,
      },
      secondary: {
        label: 'Cancel Run',
        href: null,
        controlAction: 'cancel',
        disabledReason: null,
      },
    };
  }

  if (run.status === 'paused') {
    return {
      primary: {
        label: 'Resume',
        href: null,
        controlAction: 'resume',
        disabledReason: null,
      },
      secondary: {
        label: 'Cancel Run',
        href: null,
        controlAction: 'cancel',
        disabledReason: null,
      },
    };
  }

  if (run.status === 'failed') {
    return {
      primary: {
        label: 'Retry Failed Node',
        href: null,
        controlAction: 'retry',
        disabledReason: null,
      },
      secondary: cleanupWorktreeAction,
    };
  }

  if (run.status === 'cancelled') {
    return {
      primary: {
        label: 'Run Cancelled',
        href: null,
        controlAction: null,
        disabledReason: 'Cancelled runs cannot be resumed from this view.',
      },
      secondary: cleanupWorktreeAction,
    };
  }

  if (run.status === 'pending') {
    return {
      primary: {
        label: 'Pending Start',
        href: null,
        controlAction: null,
        disabledReason: 'Run has not started yet.',
      },
      secondary: {
        label: 'Cancel Run',
        href: null,
        controlAction: 'cancel',
        disabledReason: null,
      },
    };
  }

  return {
    primary: {
      label: 'Run Cancelled',
      href: null,
      controlAction: null,
      disabledReason: 'Cancelled runs cannot be resumed from this view.',
    },
    secondary: null,
  };
}

export function toActionVerb(action: DashboardRunOperatorAction): string {
  switch (action) {
    case 'cancel':
      return 'cancel';
    case 'pause':
      return 'pause';
    case 'resume':
      return 'resume';
    case 'retry':
      return 'retry';
    case 'cleanup-worktree':
      return 'cleanup worktree';
  }
}

export function resolveRunControlErrorPrefix(action: DashboardRunOperatorAction): string {
  switch (action) {
    case 'cancel':
      return 'Unable to cancel run';
    case 'pause':
      return 'Unable to pause run';
    case 'resume':
      return 'Unable to resume run';
    case 'retry':
      return 'Unable to retry failed node';
    case 'cleanup-worktree':
      return 'Unable to clean up worktree';
  }
}

export function resolveRunControlSuccessMessage(result: DashboardRunControlResult): string {
  if (result.outcome === 'noop') {
    switch (result.action) {
      case 'cancel':
        return 'Run is already cancelled.';
      case 'pause':
        return 'Run is already paused.';
      case 'resume':
        return 'Run is already running.';
      case 'retry':
        return 'No retryable failed nodes were queued.';
    }
  }

  switch (result.action) {
    case 'cancel':
      return 'Run cancelled.';
    case 'pause':
      return 'Run paused.';
    case 'resume':
      return 'Run resumed.';
    case 'retry':
      if (result.retriedRunNodeIds.length < 1) {
        return 'Retry queued for failed nodes.';
      }

      return result.retriedRunNodeIds.length === 1
        ? 'Retry queued for 1 failed node.'
        : `Retry queued for ${result.retriedRunNodeIds.length} failed nodes.`;
  }
}

export function resolveRunWorktreeCleanupSuccessMessage(_result: DashboardRunWorktreeCleanupResult): string {
  return 'Run worktree cleanup completed.';
}


export function applyRunControlRefreshSuccess(params: {
  refreshedDetail: DashboardRunDetail;
  successMessage: string;
  enableRealtime: boolean;
  setDetail: StateSetter<DashboardRunDetail>;
  setUpdateError: StateSetter<string | null>;
  setIsRefreshing: StateSetter<boolean>;
  setLastUpdatedAtMs: StateSetter<number>;
  setNextRetryAtMs: StateSetter<number | null>;
  setChannelState: StateSetter<RealtimeChannelState>;
  setActionFeedback: StateSetter<ActionFeedbackState>;
}): void {
  const {
    refreshedDetail,
    successMessage,
    enableRealtime,
    setDetail,
    setUpdateError,
    setIsRefreshing,
    setLastUpdatedAtMs,
    setNextRetryAtMs,
    setChannelState,
    setActionFeedback,
  } = params;
  setDetail(refreshedDetail);
  setUpdateError(null);
  setIsRefreshing(false);
  setLastUpdatedAtMs(Date.now());
  setNextRetryAtMs(null);
  setChannelState(enableRealtime && isActiveRunStatus(refreshedDetail.run.status) ? 'live' : 'disabled');
  setActionFeedback({
    tone: 'success',
    message: successMessage,
    runStatus: refreshedDetail.run.status,
  });
}

export function applyRunControlRefreshFailure(params: {
  fallbackRunStatus: DashboardRunSummary['status'];
  fallbackWorktrees?: DashboardRunDetail['worktrees'];
  successMessage: string;
  refreshMessage: string;
  enableRealtime: boolean;
  setDetail: StateSetter<DashboardRunDetail>;
  setUpdateError: StateSetter<string | null>;
  setIsRefreshing: StateSetter<boolean>;
  setLastUpdatedAtMs: StateSetter<number>;
  setNextRetryAtMs: StateSetter<number | null>;
  setChannelState: StateSetter<RealtimeChannelState>;
  setActionFeedback: StateSetter<ActionFeedbackState>;
}): void {
  const {
    fallbackRunStatus,
    fallbackWorktrees,
    successMessage,
    refreshMessage,
    enableRealtime,
    setDetail,
    setUpdateError,
    setIsRefreshing,
    setLastUpdatedAtMs,
    setNextRetryAtMs,
    setChannelState,
    setActionFeedback,
  } = params;
  setDetail(currentDetail => ({
    ...currentDetail,
    run: {
      ...currentDetail.run,
      status: fallbackRunStatus,
    },
    worktrees: fallbackWorktrees ?? currentDetail.worktrees,
  }));
  setUpdateError(refreshMessage);
  setIsRefreshing(false);
  setLastUpdatedAtMs(Date.now());
  setNextRetryAtMs(null);
  setChannelState(enableRealtime && isActiveRunStatus(fallbackRunStatus) ? 'reconnecting' : 'disabled');
  setActionFeedback({
    tone: 'error',
    message: `${successMessage} Unable to refresh run timeline: ${refreshMessage}`,
    runStatus: fallbackRunStatus,
  });
}

export async function executeRunControlAction(params: ExecuteRunControlActionParams): Promise<void> {
  const {
    action,
    runId,
    runStatus,
    enableRealtime,
    setDetail,
    setUpdateError,
    setIsRefreshing,
    setLastUpdatedAtMs,
    setNextRetryAtMs,
    setChannelState,
    setActionFeedback,
  } = params;

  try {
    const response = await fetch(`/api/dashboard/runs/${runId}/actions/${action}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
      },
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, resolveRunControlErrorPrefix(action)));
    }

    const controlResult = parseRunControlPayload(payload, runId);
    if (controlResult === null) {
      throw new Error('Run action response was malformed.');
    }

    const successMessage = resolveRunControlSuccessMessage(controlResult);

    try {
      const refreshedDetail = await fetchRunDetailSnapshot(runId);
      applyRunControlRefreshSuccess({
        refreshedDetail,
        successMessage,
        enableRealtime,
        setDetail,
        setUpdateError,
        setIsRefreshing,
        setLastUpdatedAtMs,
        setNextRetryAtMs,
        setChannelState,
        setActionFeedback,
      });
    } catch (refreshError) {
      const refreshMessage = refreshError instanceof Error ? refreshError.message : 'Unable to refresh run timeline.';
      applyRunControlRefreshFailure({
        fallbackRunStatus: controlResult.runStatus,
        successMessage,
        refreshMessage,
        enableRealtime,
        setDetail,
        setUpdateError,
        setIsRefreshing,
        setLastUpdatedAtMs,
        setNextRetryAtMs,
        setChannelState,
        setActionFeedback,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : resolveRunControlErrorPrefix(action);
    setActionFeedback({
      tone: 'error',
      message,
      runStatus,
    });
  }
}

export async function executeRunWorktreeCleanupAction(params: {
  runId: number;
  runStatus: DashboardRunSummary['status'];
  enableRealtime: boolean;
  setDetail: StateSetter<DashboardRunDetail>;
  setUpdateError: StateSetter<string | null>;
  setIsRefreshing: StateSetter<boolean>;
  setLastUpdatedAtMs: StateSetter<number>;
  setNextRetryAtMs: StateSetter<number | null>;
  setChannelState: StateSetter<RealtimeChannelState>;
  setActionFeedback: StateSetter<ActionFeedbackState>;
}): Promise<void> {
  const {
    runId,
    runStatus,
    enableRealtime,
    setDetail,
    setUpdateError,
    setIsRefreshing,
    setLastUpdatedAtMs,
    setNextRetryAtMs,
    setChannelState,
    setActionFeedback,
  } = params;

  try {
    const response = await fetch(`/api/dashboard/runs/${runId}/actions/cleanup-worktree`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
      },
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, resolveRunControlErrorPrefix('cleanup-worktree')));
    }

    const cleanupResult = parseRunWorktreeCleanupPayload(payload, runId);
    if (cleanupResult === null) {
      throw new Error('Run action response was malformed.');
    }

    const successMessage = resolveRunWorktreeCleanupSuccessMessage(cleanupResult);

    try {
      const refreshedDetail = await fetchRunDetailSnapshot(runId);
      applyRunControlRefreshSuccess({
        refreshedDetail,
        successMessage,
        enableRealtime,
        setDetail,
        setUpdateError,
        setIsRefreshing,
        setLastUpdatedAtMs,
        setNextRetryAtMs,
        setChannelState,
        setActionFeedback,
      });
    } catch (refreshError) {
      const refreshMessage = refreshError instanceof Error ? refreshError.message : 'Unable to refresh run timeline.';
      applyRunControlRefreshFailure({
        fallbackRunStatus: runStatus,
        fallbackWorktrees: cleanupResult.worktrees,
        successMessage,
        refreshMessage,
        enableRealtime,
        setDetail,
        setUpdateError,
        setIsRefreshing,
        setLastUpdatedAtMs,
        setNextRetryAtMs,
        setChannelState,
        setActionFeedback,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : resolveRunControlErrorPrefix('cleanup-worktree');
    setActionFeedback({
      tone: 'error',
      message,
      runStatus,
    });
  }
}


export function triggerRunControlAction(params: {
  action: DashboardRunOperatorAction | null;
  onRunControlAction: (action: DashboardRunOperatorAction) => Promise<void>;
}): void {
  const { action, onRunControlAction } = params;
  if (action === null) {
    return;
  }

  void onRunControlAction(action);
}

export function resolveActionButtonLabel(params: {
  action: OperatorActionState;
  pendingControlAction: DashboardRunOperatorAction | null;
}): string {
  const { action, pendingControlAction } = params;
  if (action.controlAction !== null && pendingControlAction === action.controlAction) {
    return `${action.label}...`;
  }

  return action.label;
}
