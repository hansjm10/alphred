import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import type { AgentStreamConnectionState, RealtimeChannelState } from './types';

export function parseDateValue(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function padTwoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatUtcDateTime(value: Date): string {
  const year = value.getUTCFullYear();
  const month = padTwoDigits(value.getUTCMonth() + 1);
  const day = padTwoDigits(value.getUTCDate());
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());

  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

export function formatUtcTime(value: Date): string {
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());
  return `${hour}:${minute}:${second} UTC`;
}

export function formatDateTime(value: string | null, fallback: string, hasHydrated: boolean): string {
  const parsed = parseDateValue(value);
  if (parsed === null) {
    return fallback;
  }

  if (!hasHydrated) {
    return formatUtcDateTime(parsed);
  }

  return parsed.toLocaleString();
}

export function formatTimelineTime(value: Date, hasHydrated: boolean): string {
  if (!hasHydrated) {
    return formatUtcTime(value);
  }

  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatLastUpdated(value: number, hasHydrated: boolean): string {
  const parsed = new Date(value);
  if (!hasHydrated) {
    return formatUtcTime(parsed);
  }

  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function toNodeTerminalSummary(node: DashboardRunDetail['nodes'][number]): string {
  switch (node.status) {
    case 'completed':
      return `${node.nodeKey} completed.`;
    case 'failed':
      return `${node.nodeKey} failed.`;
    case 'cancelled':
      return `${node.nodeKey} was cancelled.`;
    case 'skipped':
      return `${node.nodeKey} was skipped.`;
    default:
      return `${node.nodeKey} finished with status ${node.status}.`;
  }
}

export function isTerminalNodeStatus(status: DashboardRunDetail['nodes'][number]['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled';
}

export function truncatePreview(value: string, previewLength = 140): string {
  const normalized = value.trim();
  if (normalized.length <= previewLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, previewLength - 3))}...`;
}

export function hasTruncatedPreview(value: string, previewLength = 140): boolean {
  return value.trim().length > previewLength;
}

export function resolveRealtimeLabel(
  state: RealtimeChannelState,
  pollIntervalMs: number,
  retryCountdownSeconds: number | null,
): { badgeLabel: string; detail: string } {
  if (state === 'disabled') {
    return {
      badgeLabel: 'Idle',
      detail: 'Realtime updates are paused for this run state.',
    };
  }

  if (state === 'live') {
    return {
      badgeLabel: 'Live',
      detail: `Live updates every ${Math.max(1, Math.floor(pollIntervalMs / 1000))}s (bounded polling fallback).`,
    };
  }

  if (state === 'reconnecting') {
    return {
      badgeLabel: 'Reconnecting',
      detail: `Connection interrupted. Retrying in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  return {
    badgeLabel: 'Stale',
    detail: `Latest data is stale. Reconnect attempt in ${retryCountdownSeconds ?? 0}s.`,
  };
}

export function resolveAgentStreamLabel(
  state: AgentStreamConnectionState,
  retryCountdownSeconds: number | null,
): { badgeLabel: string; detail: string } {
  if (state === 'live') {
    return {
      badgeLabel: 'Live',
      detail: 'Agent stream is connected and receiving events in real time.',
    };
  }

  if (state === 'reconnecting') {
    return {
      badgeLabel: 'Reconnecting',
      detail: `Agent stream connection interrupted. Retrying in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  if (state === 'stale') {
    return {
      badgeLabel: 'Stale',
      detail: `Agent stream is stale. Reconnect attempt in ${retryCountdownSeconds ?? 0}s.`,
    };
  }

  return {
    badgeLabel: 'Ended',
    detail: 'Node attempt reached terminal state; stream is closed.',
  };
}

export function formatStreamTimestamp(value: number): string {
  if (value >= 1_000_000_000_000) {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  return `t=${value}`;
}
