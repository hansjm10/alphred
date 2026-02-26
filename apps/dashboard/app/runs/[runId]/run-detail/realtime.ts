import type {
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
  DashboardRunNodeStreamSnapshot,
} from '../../../../src/server/dashboard-contracts';
import { isActiveRunStatus } from '../../run-summary-utils';
import {
  AGENT_STREAM_RECONNECT_MAX_MS,
  AGENT_STREAM_STALE_THRESHOLD_MS,
  RUN_DETAIL_POLL_BACKOFF_MAX_MS,
  RUN_DETAIL_STALE_THRESHOLD_MS,
  type AgentStreamConnectionState,
  type AgentStreamLifecycleEffectParams,
  type AgentStreamTarget,
  type RunDetailPollingEffectParams,
  type StateSetter,
} from './types';
import { isTerminalNodeStatus, parseDateValue } from './formatting';
import { fetchRunDetailSnapshot, parseRunNodeStreamSnapshotPayload, resolveApiErrorMessage } from './parsing';
import { hasStreamEventShape, isRecord } from './validation';

export function resolveInitialLastUpdatedAtMs(detail: DashboardRunDetail): number {
  const fallbackDate = parseDateValue(detail.run.createdAt);
  const startedAt = parseDateValue(detail.run.startedAt);
  const completedAt = parseDateValue(detail.run.completedAt);

  return completedAt?.getTime() ?? startedAt?.getTime() ?? fallbackDate?.getTime() ?? 0;
}

export function resolveInitialStreamLastUpdatedAtMs(detail: DashboardRunDetail): number {
  const runningNode = detail.nodes.find((node) => node.status === 'running');
  const fallbackNode = runningNode ?? detail.nodes[0];
  if (fallbackNode) {
    const completedAt = parseDateValue(fallbackNode.completedAt);
    const startedAt = parseDateValue(fallbackNode.startedAt);
    if (completedAt) {
      return completedAt.getTime();
    }
    if (startedAt) {
      return startedAt.getTime();
    }
  }

  return resolveInitialLastUpdatedAtMs(detail);
}

export function toAgentStreamTarget(node: DashboardRunDetail['nodes'][number]): AgentStreamTarget {
  return {
    runNodeId: node.id,
    nodeKey: node.nodeKey,
    attempt: node.attempt,
  };
}

export function resolveInitialAgentStreamTarget(detail: DashboardRunDetail): AgentStreamTarget | null {
  const runningNode = detail.nodes.find(node => node.status === 'running');
  if (runningNode) {
    return toAgentStreamTarget(runningNode);
  }

  const firstNode = detail.nodes[0];
  return firstNode ? toAgentStreamTarget(firstNode) : null;
}

export function mergeAgentStreamEvents(
  existingEvents: readonly DashboardRunNodeStreamEvent[],
  incomingEvents: readonly DashboardRunNodeStreamEvent[],
): DashboardRunNodeStreamEvent[] {
  if (incomingEvents.length === 0) {
    return [...existingEvents];
  }

  const bySequence = new Map<number, DashboardRunNodeStreamEvent>();
  for (const event of existingEvents) {
    bySequence.set(event.sequence, event);
  }
  for (const event of incomingEvents) {
    bySequence.set(event.sequence, event);
  }

  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}


export function createRunDetailPollingEffect(params: RunDetailPollingEffectParams): () => void {
  const {
    enableRealtime,
    runId,
    runStatus,
    pollIntervalMs,
    lastUpdatedAtRef,
    setChannelState,
    setIsRefreshing,
    setNextRetryAtMs,
    setUpdateError,
    setDetail,
    setLastUpdatedAtMs,
  } = params;

  if (!enableRealtime || !isActiveRunStatus(runStatus)) {
    setChannelState('disabled');
    setIsRefreshing(false);
    setNextRetryAtMs(null);
    setUpdateError(null);
    return () => undefined;
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
    const parsedDetail = await fetchRunDetailSnapshot(runId, { signal: abortController.signal });
    if (shouldSkipUpdate()) {
      return null;
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

    if (!isActiveRunStatus(parsedDetail.run.status)) {
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
}

export function resetAgentStreamState(params: {
  setStreamConnectionState: StateSetter<AgentStreamConnectionState>;
  setStreamError: StateSetter<string | null>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamNextRetryAtMs: StateSetter<number | null>;
  setStreamRetryCountdownSeconds: StateSetter<number | null>;
  streamLastSequenceRef: { current: number };
}): void {
  const {
    setStreamConnectionState,
    setStreamError,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamNextRetryAtMs,
    setStreamRetryCountdownSeconds,
    streamLastSequenceRef,
  } = params;

  setStreamConnectionState('ended');
  setStreamError(null);
  setStreamEvents([]);
  setStreamBufferedEvents([]);
  setStreamNextRetryAtMs(null);
  setStreamRetryCountdownSeconds(null);
  streamLastSequenceRef.current = 0;
}

export function buildAgentStreamUrl(
  runId: number,
  target: AgentStreamTarget,
  transport: 'snapshot' | 'sse',
  lastEventSequence: number,
): string {
  const searchParams = new URLSearchParams({
    attempt: String(target.attempt),
    lastEventSequence: String(lastEventSequence),
  });
  if (transport === 'sse') {
    searchParams.set('transport', 'sse');
  }
  return `/api/dashboard/runs/${runId}/nodes/${target.runNodeId}/stream?${searchParams.toString()}`;
}

async function fetchAgentStreamSnapshot(
  runId: number,
  target: AgentStreamTarget,
  resumeFromSequence: number,
): Promise<DashboardRunNodeStreamSnapshot> {
  const response = await fetch(buildAgentStreamUrl(runId, target, 'snapshot', resumeFromSequence), {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to load agent stream history'));
  }

  const parsed = parseRunNodeStreamSnapshotPayload(payload, runId, target.runNodeId, target.attempt);
  if (parsed === null) {
    throw new Error('Realtime agent stream response was malformed.');
  }

  return parsed;
}

export function parseMessageEventPayload(rawEvent: Event): unknown {
  const messageEvent = rawEvent as MessageEvent<string>;
  try {
    return JSON.parse(messageEvent.data);
  } catch {
    return null;
  }
}

export function resolveLatestStreamSequence(
  events: readonly DashboardRunNodeStreamEvent[],
  fallback: number,
): number {
  return events.at(-1)?.sequence ?? fallback;
}

export function appendIncomingAgentStreamEvents(params: {
  incomingEvents: readonly DashboardRunNodeStreamEvent[];
  streamLastSequenceRef: { current: number };
  streamAutoScrollRef: { current: boolean };
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamLastUpdatedAtMs: StateSetter<number>;
}): void {
  const {
    incomingEvents,
    streamLastSequenceRef,
    streamAutoScrollRef,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamLastUpdatedAtMs,
  } = params;
  if (incomingEvents.length === 0) {
    return;
  }

  const unseen = incomingEvents.filter((event) => event.sequence > streamLastSequenceRef.current);
  if (unseen.length === 0) {
    return;
  }

  const latestUnseenSequence = unseen.at(-1)?.sequence;
  if (latestUnseenSequence !== undefined) {
    streamLastSequenceRef.current = latestUnseenSequence;
  }
  setStreamLastUpdatedAtMs(Date.now());

  if (streamAutoScrollRef.current) {
    setStreamEvents((previous) => mergeAgentStreamEvents(previous, unseen));
    return;
  }

  setStreamBufferedEvents((previous) => mergeAgentStreamEvents(previous, unseen));
}

export function createAgentStreamLifecycleEffect(params: AgentStreamLifecycleEffectParams): () => void {
  const {
    runId,
    streamTarget,
    streamAutoScrollRef,
    streamLastSequenceRef,
    streamLastUpdatedAtRef,
    setStreamEvents,
    setStreamBufferedEvents,
    setStreamConnectionState,
    setStreamError,
    setStreamNextRetryAtMs,
    setStreamRetryCountdownSeconds,
    setStreamLastUpdatedAtMs,
  } = params;
  if (streamTarget === null) {
    resetAgentStreamState({
      setStreamConnectionState,
      setStreamError,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamNextRetryAtMs,
      setStreamRetryCountdownSeconds,
      streamLastSequenceRef,
    });
    return () => undefined;
  }

  if (typeof EventSource === 'undefined') {
    setStreamConnectionState('stale');
    setStreamError('Agent stream is unavailable in this environment.');
    return () => undefined;
  }

  const target = streamTarget;
  let disposed = false;
  let reconnectTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let source: EventSource | null = null;
  let reconnectFailures = 0;
  let latestNodeStatus: DashboardRunDetail['nodes'][number]['status'] = 'running';
  let streamEnded = false;

  const closeSource = (): void => {
    if (source !== null) {
      source.close();
      source = null;
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  };

  const appendIncomingEvents = (incomingEvents: readonly DashboardRunNodeStreamEvent[]): void => {
    appendIncomingAgentStreamEvents({
      incomingEvents,
      streamLastSequenceRef,
      streamAutoScrollRef,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamLastUpdatedAtMs,
    });
  };

  const handleReconnect = (): void => {
    if (disposed) {
      return;
    }

    reconnectFailures += 1;
    const retryDelayMs = Math.min(1_000 * 2 ** Math.max(0, reconnectFailures - 1), AGENT_STREAM_RECONNECT_MAX_MS);
    const retryAt = Date.now() + retryDelayMs;
    const stale = Date.now() - streamLastUpdatedAtRef.current >= AGENT_STREAM_STALE_THRESHOLD_MS;
    setStreamConnectionState(stale ? 'stale' : 'reconnecting');
    setStreamNextRetryAtMs(retryAt);
    clearReconnectTimer();
    reconnectTimeoutId = globalThis.setTimeout(() => {
      void connectEventSource();
    }, retryDelayMs);
  };

  const connectEventSource = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    closeSource();
    source = new EventSource(buildAgentStreamUrl(runId, target, 'sse', streamLastSequenceRef.current));

    source.onopen = () => {
      if (disposed) {
        return;
      }

      reconnectFailures = 0;
      setStreamConnectionState('live');
      setStreamError(null);
      setStreamNextRetryAtMs(null);
    };

    source.addEventListener('stream_event', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (!hasStreamEventShape(payload, runId, target.runNodeId, target.attempt)) {
        setStreamError('Agent stream event payload was malformed.');
        return;
      }

      appendIncomingEvents([payload]);
    });

    source.addEventListener('stream_state', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (!isRecord(payload)) {
        return;
      }

      const connectionState = payload.connectionState;
      if (connectionState === 'live' || connectionState === 'ended') {
        setStreamConnectionState(connectionState);
      }

      if (typeof payload.nodeStatus === 'string') {
        latestNodeStatus = payload.nodeStatus as DashboardRunDetail['nodes'][number]['status'];
      }
    });

    source.addEventListener('stream_end', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (isRecord(payload) && typeof payload.nodeStatus === 'string') {
        latestNodeStatus = payload.nodeStatus as DashboardRunDetail['nodes'][number]['status'];
      }

      streamEnded = true;
      setStreamConnectionState('ended');
      setStreamError(null);
      setStreamNextRetryAtMs(null);
      closeSource();
    });

    source.addEventListener('stream_error', (rawEvent: Event) => {
      const payload = parseMessageEventPayload(rawEvent);
      if (isRecord(payload) && typeof payload.message === 'string') {
        setStreamError(payload.message);
        return;
      }

      setStreamError('Agent stream channel reported an error.');
    });

    source.onerror = () => {
      closeSource();
      if (disposed || streamEnded) {
        return;
      }
      setStreamError(`Agent stream connection dropped for ${target.nodeKey} (attempt ${target.attempt}).`);
      handleReconnect();
    };
  };

  const initializeStream = async (): Promise<void> => {
    try {
      setStreamConnectionState('reconnecting');
      setStreamError(null);
      setStreamEvents([]);
      setStreamBufferedEvents([]);
      setStreamNextRetryAtMs(null);
      setStreamRetryCountdownSeconds(null);
      setStreamLastUpdatedAtMs(Date.now());
      streamLastSequenceRef.current = 0;

      let snapshot = await fetchAgentStreamSnapshot(runId, target, 0);
      let mergedEvents = mergeAgentStreamEvents([], snapshot.events);
      let resumeSequence = resolveLatestStreamSequence(mergedEvents, 0);
      while (snapshot.latestSequence > resumeSequence && snapshot.events.length > 0 && !disposed) {
        snapshot = await fetchAgentStreamSnapshot(runId, target, resumeSequence);
        mergedEvents = mergeAgentStreamEvents(mergedEvents, snapshot.events);
        resumeSequence = resolveLatestStreamSequence(mergedEvents, resumeSequence);
      }

      if (disposed) {
        return;
      }

      latestNodeStatus = snapshot.nodeStatus;
      streamLastSequenceRef.current = resumeSequence;
      setStreamEvents(mergedEvents);
      setStreamLastUpdatedAtMs(Date.now());

      if (snapshot.ended || isTerminalNodeStatus(latestNodeStatus)) {
        streamEnded = true;
        setStreamConnectionState('ended');
        setStreamError(null);
        return;
      }

      await connectEventSource();
    } catch (error) {
      if (disposed) {
        return;
      }

      setStreamError(error instanceof Error ? error.message : 'Unable to initialize agent stream.');
      handleReconnect();
    }
  };

  void initializeStream();

  return () => {
    disposed = true;
    clearReconnectTimer();
    closeSource();
  };
}
