'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DashboardRepositoryState,
  DashboardRunDetail,
  DashboardRunSummary,
} from '../../../src/server/dashboard-contracts';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../ui/primitives';

type TimelineItem = Readonly<{
  key: string;
  timestamp: Date;
  summary: string;
  relatedNodeId: number | null;
}>;

type PrimaryActionState = Readonly<{
  label: string;
  href: string | null;
  disabledReason: string | null;
}>;

type RealtimeChannelState = 'disabled' | 'live' | 'reconnecting' | 'stale';

type RunDetailContentProps = Readonly<{
  initialDetail: DashboardRunDetail;
  repositories: readonly DashboardRepositoryState[];
  enableRealtime?: boolean;
  pollIntervalMs?: number;
}>;

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const ACTIVE_RUN_STATUSES = new Set<DashboardRunSummary['status']>(['pending', 'running', 'paused']);
const RUN_STATUSES = new Set<DashboardRunSummary['status']>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const RUN_DETAIL_POLL_INTERVAL_MS = 4_000;
const RUN_DETAIL_POLL_BACKOFF_MAX_MS = 20_000;
const RUN_DETAIL_STALE_THRESHOLD_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
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

function parseRunDetailPayload(payload: unknown, expectedRunId: number): DashboardRunDetail | null {
  if (!isRecord(payload)) {
    return null;
  }

  const run = payload.run;
  if (!isRecord(run)) {
    return null;
  }

  if (run.id !== expectedRunId) {
    return null;
  }

  if (typeof run.status !== 'string' || !RUN_STATUSES.has(run.status as DashboardRunSummary['status'])) {
    return null;
  }

  if (
    !Array.isArray(payload.nodes) ||
    !Array.isArray(payload.artifacts) ||
    !Array.isArray(payload.routingDecisions) ||
    !Array.isArray(payload.worktrees)
  ) {
    return null;
  }

  return payload as DashboardRunDetail;
}

function parseDateValue(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function padTwoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

function formatUtcDateTime(value: Date): string {
  const year = value.getUTCFullYear();
  const month = padTwoDigits(value.getUTCMonth() + 1);
  const day = padTwoDigits(value.getUTCDate());
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());

  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`;
}

function formatUtcTime(value: Date): string {
  const hour = padTwoDigits(value.getUTCHours());
  const minute = padTwoDigits(value.getUTCMinutes());
  const second = padTwoDigits(value.getUTCSeconds());
  return `${hour}:${minute}:${second} UTC`;
}

function formatDateTime(value: string | null, fallback: string, hasHydrated: boolean): string {
  const parsed = parseDateValue(value);
  if (parsed === null) {
    return fallback;
  }

  if (!hasHydrated) {
    return formatUtcDateTime(parsed);
  }

  return parsed.toLocaleString();
}

function formatTimelineTime(value: Date, hasHydrated: boolean): string {
  if (!hasHydrated) {
    return formatUtcTime(value);
  }

  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLastUpdated(value: number, hasHydrated: boolean): string {
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

function toNodeTerminalSummary(node: DashboardRunDetail['nodes'][number]): string {
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

function buildTimeline(detail: DashboardRunDetail): readonly TimelineItem[] {
  const fallbackDate = parseDateValue(detail.run.createdAt) ?? new Date(0);
  const events: TimelineItem[] = [];

  const startedAt = parseDateValue(detail.run.startedAt);
  if (startedAt) {
    events.push({
      key: `run-start-${detail.run.id}`,
      timestamp: startedAt,
      summary: 'Run started.',
      relatedNodeId: null,
    });
  }

  const completedAt = parseDateValue(detail.run.completedAt);
  if (completedAt) {
    events.push({
      key: `run-terminal-${detail.run.id}`,
      timestamp: completedAt,
      summary: `Run reached terminal state (${detail.run.status}).`,
      relatedNodeId: null,
    });
  }

  for (const node of detail.nodes) {
    const nodeStartedAt = parseDateValue(node.startedAt);
    if (nodeStartedAt) {
      events.push({
        key: `node-start-${node.id}`,
        timestamp: nodeStartedAt,
        summary: `${node.nodeKey} started (attempt ${node.attempt}).`,
        relatedNodeId: node.id,
      });
    }

    const nodeCompletedAt = parseDateValue(node.completedAt);
    if (nodeCompletedAt) {
      events.push({
        key: `node-terminal-${node.id}`,
        timestamp: nodeCompletedAt,
        summary: toNodeTerminalSummary(node),
        relatedNodeId: node.id,
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const createdAt = parseDateValue(artifact.createdAt) ?? fallbackDate;
    events.push({
      key: `artifact-${artifact.id}`,
      timestamp: createdAt,
      summary: `Artifact captured (${artifact.artifactType}/${artifact.contentType}).`,
      relatedNodeId: artifact.runNodeId,
    });
  }

  for (const decision of detail.routingDecisions) {
    const createdAt = parseDateValue(decision.createdAt) ?? fallbackDate;
    events.push({
      key: `decision-${decision.id}`,
      timestamp: createdAt,
      summary: `Routing decision: ${decision.decisionType}.`,
      relatedNodeId: decision.runNodeId,
    });
  }

  return events.sort((left, right) => {
    const timeDifference = left.timestamp.getTime() - right.timestamp.getTime();
    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.key.localeCompare(right.key);
  });
}

function resolveRepositoryContext(
  detail: DashboardRunDetail,
  repositories: readonly DashboardRepositoryState[],
): string {
  if (detail.worktrees.length === 0) {
    return 'Not attached';
  }

  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]));
  const repositoryContextWorktree =
    detail.worktrees.find((worktree) => worktree.status === 'active') ??
    detail.worktrees.at(-1);
  if (!repositoryContextWorktree) {
    return 'Not attached';
  }

  return (
    repositoryNameById.get(repositoryContextWorktree.repositoryId) ??
    `Repository #${repositoryContextWorktree.repositoryId}`
  );
}

function resolvePrimaryAction(
  run: DashboardRunSummary,
  hasWorktree: boolean,
): PrimaryActionState {
  if (run.status === 'completed') {
    if (hasWorktree) {
      return {
        label: 'Open Worktree',
        href: `/runs/${run.id}/worktree`,
        disabledReason: null,
      };
    }

    return {
      label: 'Open Worktree',
      href: null,
      disabledReason: 'No worktree was captured for this run.',
    };
  }

  if (run.status === 'running') {
    return {
      label: 'Pause',
      href: null,
      disabledReason: 'Pause action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'paused') {
    return {
      label: 'Resume',
      href: null,
      disabledReason: 'Resume action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'failed') {
    return {
      label: 'Retry Failed Node',
      href: null,
      disabledReason: 'Retry action is blocked until retry controls are available.',
    };
  }

  if (run.status === 'pending') {
    return {
      label: 'Pending Start',
      href: null,
      disabledReason: 'Run has not started yet.',
    };
  }

  return {
    label: 'Run Cancelled',
    href: null,
    disabledReason: 'Cancelled runs cannot be resumed from this view.',
  };
}

function truncatePreview(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 137)}...`;
}

function resolveRealtimeLabel(
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

function resolveInitialLastUpdatedAtMs(detail: DashboardRunDetail): number {
  const fallbackDate = parseDateValue(detail.run.createdAt);
  const startedAt = parseDateValue(detail.run.startedAt);
  const completedAt = parseDateValue(detail.run.completedAt);

  return completedAt?.getTime() ?? startedAt?.getTime() ?? fallbackDate?.getTime() ?? 0;
}

export function RunDetailContent({
  initialDetail,
  repositories,
  enableRealtime = true,
  pollIntervalMs = RUN_DETAIL_POLL_INTERVAL_MS,
}: RunDetailContentProps) {
  const [detail, setDetail] = useState<DashboardRunDetail>(initialDetail);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [channelState, setChannelState] = useState<RealtimeChannelState>(() =>
    enableRealtime && ACTIVE_RUN_STATUSES.has(initialDetail.run.status) ? 'live' : 'disabled',
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<number | null>(null);
  const [filteredNodeId, setFilteredNodeId] = useState<number | null>(null);
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number>(() => resolveInitialLastUpdatedAtMs(initialDetail));
  const [nextRetryAtMs, setNextRetryAtMs] = useState<number | null>(null);
  const [retryCountdownSeconds, setRetryCountdownSeconds] = useState<number | null>(null);
  const [hasHydrated, setHasHydrated] = useState<boolean>(false);

  const lastUpdatedAtRef = useRef<number>(lastUpdatedAtMs);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    setDetail(initialDetail);
    setUpdateError(null);
    setIsRefreshing(false);
    setNextRetryAtMs(null);
    setRetryCountdownSeconds(null);
    setLastUpdatedAtMs(Date.now());
    setChannelState(enableRealtime && ACTIVE_RUN_STATUSES.has(initialDetail.run.status) ? 'live' : 'disabled');
  }, [enableRealtime, initialDetail]);

  useEffect(() => {
    lastUpdatedAtRef.current = lastUpdatedAtMs;
  }, [lastUpdatedAtMs]);

  useEffect(() => {
    if (highlightedNodeId !== null && !detail.nodes.some((node) => node.id === highlightedNodeId)) {
      setHighlightedNodeId(null);
    }

    if (filteredNodeId !== null && !detail.nodes.some((node) => node.id === filteredNodeId)) {
      setFilteredNodeId(null);
    }
  }, [detail.nodes, filteredNodeId, highlightedNodeId]);

  useEffect(() => {
    if (!enableRealtime || !ACTIVE_RUN_STATUSES.has(detail.run.status)) {
      setChannelState('disabled');
      setIsRefreshing(false);
      setNextRetryAtMs(null);
      setUpdateError(null);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let consecutiveFailures = 0;
    const shouldSkipUpdate = (): boolean => cancelled || abortController.signal.aborted;

    const scheduleNextPoll = (delayMs: number): void => {
      timeoutId = globalThis.setTimeout(() => {
        void pollRunDetail();
      }, delayMs);
    };

    const fetchLatestRunDetail = async (): Promise<DashboardRunDetail | null> => {
      const response = await fetch(`/api/dashboard/runs/${detail.run.id}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
        signal: abortController.signal,
      });
      if (shouldSkipUpdate()) {
        return null;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      if (shouldSkipUpdate()) {
        return null;
      }
      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh run timeline'));
      }

      const parsedDetail = parseRunDetailPayload(payload, detail.run.id);
      if (parsedDetail === null) {
        throw new Error('Realtime run detail response was malformed.');
      }

      return shouldSkipUpdate() ? null : parsedDetail;
    };

    const applySuccessfulPoll = (parsedDetail: DashboardRunDetail): void => {
      consecutiveFailures = 0;
      setDetail(parsedDetail);
      setUpdateError(null);
      setIsRefreshing(false);
      setLastUpdatedAtMs(Date.now());
      setNextRetryAtMs(null);

      if (!ACTIVE_RUN_STATUSES.has(parsedDetail.run.status)) {
        setChannelState('disabled');
        return;
      }

      setChannelState('live');
      if (!cancelled) {
        scheduleNextPoll(pollIntervalMs);
      }
    };

    const handlePollFailure = (error: unknown): void => {
      const isAbortError = error instanceof Error && error.name === 'AbortError';
      if (shouldSkipUpdate() || isAbortError) {
        return;
      }

      consecutiveFailures += 1;
      const retryDelayMs = Math.min(
        pollIntervalMs * 2 ** Math.max(0, consecutiveFailures - 1),
        RUN_DETAIL_POLL_BACKOFF_MAX_MS,
      );
      const retryAt = Date.now() + retryDelayMs;
      const stale = Date.now() - lastUpdatedAtRef.current >= RUN_DETAIL_STALE_THRESHOLD_MS;

      setChannelState(stale ? 'stale' : 'reconnecting');
      setNextRetryAtMs(retryAt);
      setIsRefreshing(false);
      setUpdateError(error instanceof Error ? error.message : 'Unable to refresh run timeline.');

      if (!cancelled) {
        scheduleNextPoll(retryDelayMs);
      }
    };

    const pollRunDetail = async (): Promise<void> => {
      if (shouldSkipUpdate()) {
        return;
      }

      setIsRefreshing(true);
      try {
        const parsedDetail = await fetchLatestRunDetail();
        if (parsedDetail === null) {
          return;
        }

        applySuccessfulPoll(parsedDetail);
      } catch (error) {
        handlePollFailure(error);
      }
    };

    scheduleNextPoll(pollIntervalMs);

    return () => {
      cancelled = true;
      abortController.abort();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [detail.run.id, detail.run.status, enableRealtime, pollIntervalMs]);

  useEffect(() => {
    if (nextRetryAtMs === null) {
      setRetryCountdownSeconds(null);
      return;
    }

    const updateCountdown = (): void => {
      const remainingSeconds = Math.max(0, Math.ceil((nextRetryAtMs - Date.now()) / 1000));
      setRetryCountdownSeconds(remainingSeconds);
    };

    updateCountdown();
    const intervalId = globalThis.setInterval(updateCountdown, 250);

    return () => {
      clearInterval(intervalId);
    };
  }, [nextRetryAtMs]);

  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const repositoryContext = useMemo(
    () => resolveRepositoryContext(detail, repositories),
    [detail, repositories],
  );
  const primaryAction = useMemo(
    () => resolvePrimaryAction(detail.run, detail.worktrees.length > 0),
    [detail.run, detail.worktrees.length],
  );
  const selectedNode = useMemo(
    () => detail.nodes.find((node) => node.id === filteredNodeId) ?? null,
    [detail.nodes, filteredNodeId],
  );
  const visibleTimeline = useMemo(
    () =>
      filteredNodeId === null
        ? timeline
        : timeline.filter((event) => event.relatedNodeId === null || event.relatedNodeId === filteredNodeId),
    [filteredNodeId, timeline],
  );
  const realtimeLabel = resolveRealtimeLabel(channelState, pollIntervalMs, retryCountdownSeconds);
  const toggleNodeFilter = (nodeId: number): void => {
    const nextNodeId = filteredNodeId === nodeId ? null : nodeId;
    setFilteredNodeId(nextNodeId);
    setHighlightedNodeId(nextNodeId);
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>Timeline and node lifecycle reflect persisted run data from dashboard APIs.</p>
      </section>

      <div className="page-grid">
        <Card title="Run summary" description="Current status and context">
          <ul className="entity-list">
            <li>
              <span>Status</span>
              <StatusBadge status={detail.run.status} />
            </li>
            <li>
              <span>Workflow</span>
              <span className="meta-text">{`${detail.run.tree.name} (${detail.run.tree.treeKey})`}</span>
            </li>
            <li>
              <span>Repository context</span>
              <span className="meta-text">{repositoryContext}</span>
            </li>
            <li>
              <span>Worktrees</span>
              <span className="meta-text">{detail.worktrees.length}</span>
            </li>
            <li>
              <span>Started</span>
              <span className="meta-text">{formatDateTime(detail.run.startedAt, 'Not started', hasHydrated)}</span>
            </li>
            <li>
              <span>Completed</span>
              <span className="meta-text">{formatDateTime(detail.run.completedAt, 'In progress', hasHydrated)}</span>
            </li>
          </ul>
        </Card>

        <Panel title="Actions" description="Invalid actions are blocked by current lifecycle state.">
          <div className="action-row">
            {primaryAction.href ? (
              <ButtonLink href={primaryAction.href} tone="primary">
                {primaryAction.label}
              </ButtonLink>
            ) : (
              <ActionButton tone="primary" disabled aria-disabled="true" title={primaryAction.disabledReason ?? undefined}>
                {primaryAction.label}
              </ActionButton>
            )}
            <ButtonLink href="/runs">Back to Runs</ButtonLink>
          </div>
          {primaryAction.disabledReason ? <p className="meta-text run-action-feedback">{primaryAction.disabledReason}</p> : null}

          <output className={`run-realtime-status run-realtime-status--${channelState}`} aria-live="polite">
            <span className="run-realtime-status__badge">{realtimeLabel.badgeLabel}</span>
            <span className="meta-text">{realtimeLabel.detail}</span>
            <span className="meta-text">
              {`Last updated ${formatLastUpdated(lastUpdatedAtMs, hasHydrated)}.`}
              {isRefreshing ? ' Refreshing timeline...' : ''}
            </span>
          </output>

          {updateError && (channelState === 'reconnecting' || channelState === 'stale') ? (
            <output className="run-realtime-warning" aria-live="polite">
              {`Update channel degraded: ${updateError}`}
            </output>
          ) : null}
        </Panel>
      </div>

      <div className="page-grid">
        <Card title="Timeline" description="Latest run events">
          {selectedNode ? (
            <div className="run-timeline-filter">
              <p className="meta-text">{`Filtered to ${selectedNode.nodeKey} (attempt ${selectedNode.attempt}).`}</p>
              <ActionButton
                className="run-timeline-clear"
                onClick={() => {
                  setFilteredNodeId(null);
                  setHighlightedNodeId(null);
                }}
              >
                Show all events
              </ActionButton>
            </div>
          ) : null}

          <ol className="page-stack" aria-label="Run timeline">
            {visibleTimeline.length > 0 ? (
              visibleTimeline.map((event) => {
                const highlighted = highlightedNodeId !== null && event.relatedNodeId === highlightedNodeId;

                return (
                  <li key={event.key}>
                    <button
                      type="button"
                      className={`run-timeline-event${highlighted ? ' run-timeline-event--selected' : ''}`}
                      aria-pressed={highlighted}
                      onClick={() => {
                        setHighlightedNodeId(event.relatedNodeId);
                      }}
                    >
                      <p className="meta-text">{formatTimelineTime(event.timestamp, hasHydrated)}</p>
                      <p>{event.summary}</p>
                    </button>
                  </li>
                );
              })
            ) : (
              <li>
                <p>{filteredNodeId === null ? 'No lifecycle events captured yet.' : 'No events match the selected node.'}</p>
              </li>
            )}
          </ol>
        </Card>

        <Panel title="Node status" description="Node lifecycle snapshot">
          <ul className="entity-list run-node-status-list">
            {detail.nodes.length > 0 ? (
              detail.nodes.map((node) => {
                const selected = highlightedNodeId === node.id;

                return (
                  <li key={node.id}>
                    <ActionButton
                      className={`run-node-filter${selected ? ' run-node-filter--selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        toggleNodeFilter(node.id);
                      }}
                    >
                      {`${node.nodeKey} (attempt ${node.attempt})`}
                    </ActionButton>
                    <StatusBadge status={node.status} />
                  </li>
                );
              })
            ) : (
              <li>
                <span>No run nodes have been materialized yet.</span>
              </li>
            )}
          </ul>
        </Panel>
      </div>

      <Card title="Artifacts and routing decisions" description="Recent snapshots for operator triage.">
        <p className="meta-text">Artifacts</p>
        {detail.artifacts.length === 0 ? <p>No artifacts captured yet.</p> : null}
        <ul className="page-stack" aria-label="Run artifacts">
          {detail.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <p>{`${artifact.artifactType} (${artifact.contentType})`}</p>
              <p className="meta-text">{truncatePreview(artifact.contentPreview)}</p>
            </li>
          ))}
        </ul>

        <p className="meta-text">Routing decisions</p>
        {detail.routingDecisions.length === 0 ? <p>No routing decisions captured yet.</p> : null}
        <ul className="page-stack" aria-label="Run routing decisions">
          {detail.routingDecisions.map((decision) => (
            <li key={decision.id}>
              <p>{decision.decisionType}</p>
              <p className="meta-text">{decision.rationale ?? 'No rationale provided.'}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
