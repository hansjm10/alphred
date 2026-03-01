'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DashboardRunControlAction,
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
} from '../../../../src/server/dashboard-contracts';
import { Panel } from '../../../ui/primitives';
import { isActiveRunStatus } from '../../run-summary-utils';
import {
  executeRunControlAction,
  resolveOperatorActions,
  toActionVerb,
} from './actions';
import { formatDateTime, resolveAgentStreamLabel, resolveRealtimeLabel } from './formatting';
import { RunDetailLifecycleGrid } from './lifecycle-grid';
import { RunObservabilityCard } from './observability-card';
import { RunOperatorFocusCard } from './operator-card';
import {
  createAgentStreamLifecycleEffect,
  createRunDetailPollingEffect,
  resolveInitialAgentStreamTarget,
  resolveInitialLastUpdatedAtMs,
  resolveInitialStreamLastUpdatedAtMs,
  toAgentStreamTarget,
} from './realtime';
import {
  clearActionFeedbackOnStatusChange,
  createRetryCountdownEffect,
  flushBufferedAgentStreamEvents,
  resetRunDetailStateFromInitialDetail,
  syncSelectionStateWithNodes,
  syncStreamEventListScroll,
  toggleNodeFilterState,
} from './state';
import { RunAgentStreamCard } from './stream-card';
import { buildTimeline, partitionByRecency, resolveRepositoryContext } from './timeline';
import {
  RUN_DETAIL_POLL_INTERVAL_MS,
  RUN_TIMELINE_RECENT_EVENT_COUNT,
  type ActionFeedbackState,
  type AgentStreamConnectionState,
  type AgentStreamTarget,
  type RealtimeChannelState,
  type RunDetailContentProps,
} from './types';

export function RunDetailContent({
  initialDetail,
  repositories,
  enableRealtime = true,
  pollIntervalMs = RUN_DETAIL_POLL_INTERVAL_MS,
}: RunDetailContentProps) {
  const [detail, setDetail] = useState<DashboardRunDetail>(initialDetail);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [channelState, setChannelState] = useState<RealtimeChannelState>(() =>
    enableRealtime && isActiveRunStatus(initialDetail.run.status) ? 'live' : 'disabled',
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<number | null>(null);
  const [filteredNodeId, setFilteredNodeId] = useState<number | null>(null);
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number>(() => resolveInitialLastUpdatedAtMs(initialDetail));
  const [nextRetryAtMs, setNextRetryAtMs] = useState<number | null>(null);
  const [retryCountdownSeconds, setRetryCountdownSeconds] = useState<number | null>(null);
  const [hasHydrated, setHasHydrated] = useState<boolean>(false);
  const [streamTarget, setStreamTarget] = useState<AgentStreamTarget | null>(() =>
    resolveInitialAgentStreamTarget(initialDetail),
  );
  const [streamEvents, setStreamEvents] = useState<DashboardRunNodeStreamEvent[]>([]);
  const [streamBufferedEvents, setStreamBufferedEvents] = useState<DashboardRunNodeStreamEvent[]>([]);
  const [streamConnectionState, setStreamConnectionState] = useState<AgentStreamConnectionState>('ended');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamNextRetryAtMs, setStreamNextRetryAtMs] = useState<number | null>(null);
  const [streamRetryCountdownSeconds, setStreamRetryCountdownSeconds] = useState<number | null>(null);
  const [streamAutoScroll, setStreamAutoScroll] = useState<boolean>(true);
  const [streamLastUpdatedAtMs, setStreamLastUpdatedAtMs] = useState<number>(() =>
    resolveInitialStreamLastUpdatedAtMs(initialDetail),
  );
  const [streamSelectedEventSequence, setStreamSelectedEventSequence] = useState<number | null>(null);
  const [streamInspectorUrlStateReadyRunId, setStreamInspectorUrlStateReadyRunId] = useState<number | null>(null);
  const [pendingControlAction, setPendingControlAction] = useState<DashboardRunControlAction | null>(null);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedbackState>(null);

  const lastUpdatedAtRef = useRef<number>(lastUpdatedAtMs);
  const streamLastUpdatedAtRef = useRef<number>(streamLastUpdatedAtMs);
  const streamLastSequenceRef = useRef<number>(0);
  const streamEventListRef = useRef<HTMLOListElement | null>(null);
  const streamAutoScrollRef = useRef<boolean>(streamAutoScroll);
  const streamInspectorUrlStateRunIdRef = useRef<number | null>(null);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    resetRunDetailStateFromInitialDetail({
      initialDetail,
      enableRealtime,
      streamLastSequenceRef,
      setDetail,
      setUpdateError,
      setIsRefreshing,
      setNextRetryAtMs,
      setRetryCountdownSeconds,
      setLastUpdatedAtMs,
      setChannelState,
      setStreamTarget,
      setStreamEvents,
      setStreamBufferedEvents,
      setStreamConnectionState,
      setStreamError,
      setStreamNextRetryAtMs,
      setStreamRetryCountdownSeconds,
      setStreamAutoScroll,
      setStreamLastUpdatedAtMs,
      setStreamSelectedEventSequence,
      setPendingControlAction,
      setActionFeedback,
    });
  }, [enableRealtime, initialDetail]);

  useEffect(() => {
    lastUpdatedAtRef.current = lastUpdatedAtMs;
  }, [lastUpdatedAtMs]);

  useEffect(() => {
    streamLastUpdatedAtRef.current = streamLastUpdatedAtMs;
  }, [streamLastUpdatedAtMs]);

  useEffect(() => {
    streamAutoScrollRef.current = streamAutoScroll;
  }, [streamAutoScroll]);

  useEffect(() => {
    syncSelectionStateWithNodes({
      nodes: detail.nodes,
      highlightedNodeId,
      filteredNodeId,
      streamTarget,
      setHighlightedNodeId,
      setFilteredNodeId,
      setStreamTarget,
    });
  }, [detail.nodes, filteredNodeId, highlightedNodeId, streamTarget]);

  useEffect(() => {
    return createRunDetailPollingEffect({
      enableRealtime,
      runId: detail.run.id,
      runStatus: detail.run.status,
      pollIntervalMs,
      lastUpdatedAtRef,
      setChannelState,
      setIsRefreshing,
      setNextRetryAtMs,
      setUpdateError,
      setDetail,
      setLastUpdatedAtMs,
    });
  }, [detail.run.id, detail.run.status, enableRealtime, pollIntervalMs]);

  useEffect(() => {
    if (streamInspectorUrlStateReadyRunId !== detail.run.id) {
      return () => undefined;
    }

    return createAgentStreamLifecycleEffect({
      runId: detail.run.id,
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
    });
  }, [detail.run.id, streamInspectorUrlStateReadyRunId, streamTarget]);

  useEffect(() => {
    flushBufferedAgentStreamEvents({
      streamAutoScroll,
      streamBufferedEvents,
      setStreamEvents,
      setStreamBufferedEvents,
    });
  }, [streamAutoScroll, streamBufferedEvents]);

  useEffect(() => {
    syncStreamEventListScroll({
      streamAutoScroll,
      streamEventListRef,
    });
  }, [streamAutoScroll, streamEvents]);

  useEffect(() => {
    return createRetryCountdownEffect({
      retryAtMs: nextRetryAtMs,
      setRetryCountdownSeconds,
    });
  }, [nextRetryAtMs]);

  useEffect(() => {
    return createRetryCountdownEffect({
      retryAtMs: streamNextRetryAtMs,
      setRetryCountdownSeconds: setStreamRetryCountdownSeconds,
    });
  }, [streamNextRetryAtMs]);

  useEffect(() => {
    clearActionFeedbackOnStatusChange({
      runStatus: detail.run.status,
      setActionFeedback,
    });
  }, [detail.run.status]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (streamInspectorUrlStateRunIdRef.current === detail.run.id) {
      return;
    }
    streamInspectorUrlStateRunIdRef.current = detail.run.id;

    const searchParams = new URLSearchParams(window.location.search);
    const rawRunNodeId = searchParams.get('streamRunNodeId');
    const rawAttempt = searchParams.get('streamAttempt');
    const rawEventSequence = searchParams.get('streamEventSequence');

    const runNodeId = rawRunNodeId === null ? Number.NaN : Number(rawRunNodeId);
    const attempt = rawAttempt === null ? Number.NaN : Number(rawAttempt);
    const eventSequence = rawEventSequence === null ? Number.NaN : Number(rawEventSequence);

    const targetNode = Number.isInteger(runNodeId) && runNodeId > 0
      ? detail.nodes.find((node) => node.id === runNodeId)
      : null;

    if (targetNode && (!Number.isInteger(attempt) || attempt < 1 || targetNode.attempt === attempt)) {
      setStreamTarget(toAgentStreamTarget(targetNode));
    }

    if (Number.isInteger(eventSequence) && eventSequence > 0) {
      setStreamSelectedEventSequence(eventSequence);
    } else {
      setStreamSelectedEventSequence(null);
    }

    setStreamInspectorUrlStateReadyRunId(detail.run.id);
  }, [detail.nodes, detail.run.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || streamInspectorUrlStateReadyRunId !== detail.run.id) {
      return;
    }

    const url = new URL(window.location.href);
    const searchParams = url.searchParams;

    if (streamTarget) {
      searchParams.set('streamRunNodeId', String(streamTarget.runNodeId));
      searchParams.set('streamAttempt', String(streamTarget.attempt));

      if (streamSelectedEventSequence !== null) {
        searchParams.set('streamEventSequence', String(streamSelectedEventSequence));
      } else {
        searchParams.delete('streamEventSequence');
      }
    } else {
      if (streamSelectedEventSequence !== null) {
        setStreamSelectedEventSequence(null);
      }
      searchParams.delete('streamRunNodeId');
      searchParams.delete('streamAttempt');
      searchParams.delete('streamEventSequence');
    }

    const nextSearch = searchParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  }, [detail.run.id, streamInspectorUrlStateReadyRunId, streamSelectedEventSequence, streamTarget]);

  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const repositoryContext = useMemo(
    () => resolveRepositoryContext(detail, repositories),
    [detail, repositories],
  );
  const pageSubtitle = detail.run.repository
    ? `${detail.run.tree.name} · ${detail.run.repository.name}`
    : detail.run.tree.name;
  const operatorActions = useMemo(
    () => resolveOperatorActions(detail.run, detail.worktrees.length > 0),
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
  const latestTimelineEvent = timeline.at(-1) ?? null;
  const visibleTimelinePartition = useMemo(
    () => partitionByRecency(visibleTimeline, RUN_TIMELINE_RECENT_EVENT_COUNT),
    [visibleTimeline],
  );
  const realtimeLabel = resolveRealtimeLabel(channelState, pollIntervalMs, retryCountdownSeconds);
  const agentStreamLabel = resolveAgentStreamLabel(streamConnectionState, streamRetryCountdownSeconds);
  const selectedStreamNode = useMemo(
    () => (streamTarget ? detail.nodes.find(node => node.id === streamTarget.runNodeId) ?? null : null),
    [detail.nodes, streamTarget],
  );
  const primaryAction = operatorActions.primary;
  const secondaryAction = operatorActions.secondary;
  const actionHint = actionFeedback?.message ?? primaryAction.disabledReason ?? secondaryAction?.disabledReason ?? null;
  const actionHintTone = actionFeedback?.tone ?? 'info';

  const toggleNodeFilter = (nodeId: number): void => {
    toggleNodeFilterState({
      nodeId,
      filteredNodeId,
      nodes: detail.nodes,
      streamTarget,
      setFilteredNodeId,
      setHighlightedNodeId,
      setStreamTarget,
      setStreamAutoScroll,
      setStreamBufferedEvents,
    });
  };

  const handleRunControlAction = async (action: DashboardRunControlAction): Promise<void> => {
    if (pendingControlAction !== null) {
      return;
    }

    setPendingControlAction(action);
    setActionFeedback({
      tone: 'info',
      message: `Applying ${toActionVerb(action)} action...`,
      runStatus: null,
    });
    await executeRunControlAction({
      action,
      runId: detail.run.id,
      runStatus: detail.run.status,
      enableRealtime,
      setDetail,
      setUpdateError,
      setIsRefreshing,
      setLastUpdatedAtMs,
      setNextRetryAtMs,
      setChannelState,
      setActionFeedback,
    });
    setPendingControlAction(null);
  };

  const clearNodeFilter = (): void => {
    setFilteredNodeId(null);
    setHighlightedNodeId(null);
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>{pageSubtitle}</p>
      </section>

      <div className="page-grid run-detail-priority-grid">
        <RunOperatorFocusCard
          detail={detail}
          latestTimelineEvent={latestTimelineEvent}
          hasHydrated={hasHydrated}
          primaryAction={primaryAction}
          secondaryAction={secondaryAction}
          pendingControlAction={pendingControlAction}
          actionHint={actionHint}
          actionHintTone={actionHintTone}
          channelState={channelState}
          realtimeLabel={realtimeLabel}
          lastUpdatedAtMs={lastUpdatedAtMs}
          isRefreshing={isRefreshing}
          updateError={updateError}
          onRunControlAction={handleRunControlAction}
        />

        <Panel title="Run summary" description="Workflow context and timestamps." className="run-detail-summary-panel">
          <ul className="entity-list run-detail-summary-list">
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
        </Panel>
      </div>

      <RunDetailLifecycleGrid
        detail={detail}
        selectedNode={selectedNode}
        filteredNodeId={filteredNodeId}
        highlightedNodeId={highlightedNodeId}
        hasHydrated={hasHydrated}
        visibleTimeline={visibleTimeline}
        visibleTimelinePartition={visibleTimelinePartition}
        onSelectTimelineNode={setHighlightedNodeId}
        onClearNodeFilter={clearNodeFilter}
        onToggleNodeFilter={toggleNodeFilter}
      />

      <RunAgentStreamCard
        isTerminalRun={!isActiveRunStatus(detail.run.status)}
        selectedStreamNode={selectedStreamNode}
        agentStreamLabel={agentStreamLabel}
        streamConnectionState={streamConnectionState}
        streamLastUpdatedAtMs={streamLastUpdatedAtMs}
        hasHydrated={hasHydrated}
        streamAutoScroll={streamAutoScroll}
        streamBufferedEvents={streamBufferedEvents}
        streamError={streamError}
        streamEvents={streamEvents}
        streamEventListRef={streamEventListRef}
        selectedEventSequence={streamSelectedEventSequence}
        onSelectedEventSequenceChange={setStreamSelectedEventSequence}
        setStreamAutoScroll={setStreamAutoScroll}
        setStreamBufferedEvents={setStreamBufferedEvents}
        setStreamEvents={setStreamEvents}
      />

      <RunObservabilityCard detail={detail} />
    </div>
  );
}
