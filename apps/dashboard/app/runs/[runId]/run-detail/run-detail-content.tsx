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
  isSameStreamTarget,
  isStreamSupportedNodeStatus,
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

function parseNumericSearchParam(value: string | null): number {
  if (value === null) {
    return Number.NaN;
  }

  return Number(value);
}

function resolveStreamTargetFromUrlSearch(
  nodes: DashboardRunDetail['nodes'],
  streamInspectorUrlSearch: string,
): Readonly<{ streamTarget: AgentStreamTarget | null; eventSequence: number | null }> {
  const searchParams = new URLSearchParams(streamInspectorUrlSearch);
  const runNodeId = parseNumericSearchParam(searchParams.get('streamRunNodeId'));

  if (!Number.isInteger(runNodeId) || runNodeId < 1) {
    return { streamTarget: null, eventSequence: null };
  }

  const targetNode = nodes.find((node) => node.id === runNodeId);
  if (!targetNode || !isStreamSupportedNodeStatus(targetNode.status)) {
    return { streamTarget: null, eventSequence: null };
  }

  const attempt = parseNumericSearchParam(searchParams.get('streamAttempt'));
  const attemptMatchesNode = !Number.isInteger(attempt) || attempt < 1 || targetNode.attempt === attempt;
  if (!attemptMatchesNode) {
    return { streamTarget: null, eventSequence: null };
  }

  const eventSequence = parseNumericSearchParam(searchParams.get('streamEventSequence'));
  const nextEventSequence = Number.isInteger(eventSequence) && eventSequence > 0 ? eventSequence : null;

  return {
    streamTarget: toAgentStreamTarget(targetNode),
    eventSequence: nextEventSequence,
  };
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
  const streamInspectorUrlStateRef = useRef<Readonly<{ runId: number | null; search: string | null }>>({
    runId: null,
    search: null,
  });
  const streamInspectorUrlSearch = globalThis.window?.location.search ?? '';

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    setStreamInspectorUrlStateReadyRunId(null);
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
    if (!globalThis.window) {
      return;
    }

    if (
      streamInspectorUrlStateReadyRunId === detail.run.id &&
      streamInspectorUrlStateRef.current.runId === detail.run.id &&
      streamInspectorUrlStateRef.current.search === streamInspectorUrlSearch
    ) {
      return;
    }
    streamInspectorUrlStateRef.current = {
      runId: detail.run.id,
      search: streamInspectorUrlSearch,
    };

    const urlSelection = resolveStreamTargetFromUrlSearch(detail.nodes, streamInspectorUrlSearch);

    if (urlSelection.streamTarget && !isSameStreamTarget(streamTarget, urlSelection.streamTarget)) {
      setStreamTarget(urlSelection.streamTarget);
    }

    if (streamSelectedEventSequence !== urlSelection.eventSequence) {
      setStreamSelectedEventSequence(urlSelection.eventSequence);
    }

    if (streamInspectorUrlStateReadyRunId !== detail.run.id) {
      setStreamInspectorUrlStateReadyRunId(detail.run.id);
    }
  }, [
    detail.nodes,
    detail.run.id,
    streamInspectorUrlSearch,
    streamInspectorUrlStateReadyRunId,
    streamSelectedEventSequence,
    streamTarget,
  ]);

  useEffect(() => {
    const browserWindow = globalThis.window;
    if (!browserWindow || streamInspectorUrlStateReadyRunId !== detail.run.id) {
      return;
    }

    const url = new URL(browserWindow.location.href);
    const searchParams = url.searchParams;

    if (streamTarget) {
      searchParams.set('streamRunNodeId', String(streamTarget.runNodeId));
      searchParams.set('streamAttempt', String(streamTarget.attempt));
    } else {
      searchParams.delete('streamRunNodeId');
      searchParams.delete('streamAttempt');
    }

    if (streamTarget && streamSelectedEventSequence !== null) {
      searchParams.set('streamEventSequence', String(streamSelectedEventSequence));
    } else {
      searchParams.delete('streamEventSequence');
    }

    if (!streamTarget && streamSelectedEventSequence !== null) {
      setStreamSelectedEventSequence(null);
    }

    const nextSearch = searchParams.toString();
    const nextSearchValue = nextSearch ? `?${nextSearch}` : '';
    const nextUrl = `${url.pathname}${nextSearchValue}${url.hash}`;
    const currentUrl = `${browserWindow.location.pathname}${browserWindow.location.search}${browserWindow.location.hash}`;

    if (nextUrl !== currentUrl) {
      browserWindow.history.replaceState(browserWindow.history.state, '', nextUrl);
      streamInspectorUrlStateRef.current = {
        runId: detail.run.id,
        search: nextSearchValue,
      };
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
        nodes={detail.nodes}
        diagnostics={detail.diagnostics}
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
        onSelectStreamTarget={(target) => {
          setStreamAutoScroll(true);
          setStreamBufferedEvents([]);
          setStreamSelectedEventSequence(null);
          setStreamTarget(target);
        }}
        setStreamAutoScroll={setStreamAutoScroll}
        setStreamBufferedEvents={setStreamBufferedEvents}
        setStreamEvents={setStreamEvents}
      />

      <RunObservabilityCard detail={detail} />
    </div>
  );
}
