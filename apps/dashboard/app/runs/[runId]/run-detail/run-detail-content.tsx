'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import {
  RUN_DETAIL_SECTION_JUMP_ITEMS,
  RunDetailSectionJumpNav,
  type RunDetailSectionJumpKey,
} from './section-jump-nav';
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

type RunDetailSectionDefinition = Readonly<{
  key: RunDetailSectionJumpKey;
  sectionId: string;
  headingId: string;
  compact: boolean;
}>;

const RUN_DETAIL_SECTION_DEFINITIONS: readonly RunDetailSectionDefinition[] = [
  {
    key: 'focus',
    sectionId: 'run-detail-operator-focus-section',
    headingId: 'run-detail-operator-focus-heading',
    compact: true,
  },
  {
    key: 'timeline',
    sectionId: 'run-detail-timeline-section',
    headingId: 'run-detail-timeline-heading',
    compact: false,
  },
  {
    key: 'stream',
    sectionId: 'run-detail-stream-section',
    headingId: 'run-detail-stream-heading',
    compact: false,
  },
  {
    key: 'observability',
    sectionId: 'run-detail-observability-section',
    headingId: 'run-detail-observability-heading',
    compact: false,
  },
];

const RUN_DETAIL_SECTION_KEYS = new Set<RunDetailSectionJumpKey>(
  RUN_DETAIL_SECTION_DEFINITIONS.map((sectionDefinition) => sectionDefinition.key),
);
const RUN_DETAIL_SECTION_KEY_BY_HASH = new Map<string, RunDetailSectionJumpKey>([
  ...RUN_DETAIL_SECTION_JUMP_ITEMS.map((sectionItem) => [sectionItem.hash, sectionItem.key] as const),
  ...RUN_DETAIL_SECTION_DEFINITIONS.map((sectionDefinition) => [`#${sectionDefinition.sectionId}`, sectionDefinition.key] as const),
]);
const RUN_DETAIL_DEFAULT_SECTION_KEY: RunDetailSectionJumpKey = RUN_DETAIL_SECTION_JUMP_ITEMS[0]?.key ?? 'focus';

function isRunDetailSectionKey(candidate: string | undefined): candidate is RunDetailSectionJumpKey {
  return candidate !== undefined && RUN_DETAIL_SECTION_KEYS.has(candidate as RunDetailSectionJumpKey);
}

function resolveRunDetailSectionKeyFromHash(hash: string): RunDetailSectionJumpKey | null {
  if (hash.length === 0) {
    return null;
  }

  const normalizedHash = hash.startsWith('#') ? hash : `#${hash}`;
  return RUN_DETAIL_SECTION_KEY_BY_HASH.get(normalizedHash) ?? null;
}

function resolveRunDetailSectionKeyFromElement(element: Element | null): RunDetailSectionJumpKey | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const sectionKey = element.dataset.runDetailSection;
  return isRunDetailSectionKey(sectionKey) ? sectionKey : null;
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
  const [pendingControlAction, setPendingControlAction] = useState<DashboardRunControlAction | null>(null);
  const [actionFeedback, setActionFeedback] = useState<ActionFeedbackState>(null);
  const [activeSection, setActiveSection] = useState<RunDetailSectionJumpKey>(RUN_DETAIL_DEFAULT_SECTION_KEY);

  const pageStackRef = useRef<HTMLDivElement | null>(null);
  const lastUpdatedAtRef = useRef<number>(lastUpdatedAtMs);
  const streamLastUpdatedAtRef = useRef<number>(streamLastUpdatedAtMs);
  const streamLastSequenceRef = useRef<number>(0);
  const streamEventListRef = useRef<HTMLOListElement | null>(null);
  const streamAutoScrollRef = useRef<boolean>(streamAutoScroll);

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
  }, [detail.run.id, streamTarget]);

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

    const syncActiveSectionFromHash = (): void => {
      const sectionFromHash = resolveRunDetailSectionKeyFromHash(window.location.hash);
      setActiveSection(sectionFromHash ?? RUN_DETAIL_DEFAULT_SECTION_KEY);
    };

    syncActiveSectionFromHash();

    if (typeof window.IntersectionObserver === 'function') {
      return;
    }

    window.addEventListener('hashchange', syncActiveSectionFromHash);
    window.addEventListener('popstate', syncActiveSectionFromHash);
    return () => {
      window.removeEventListener('hashchange', syncActiveSectionFromHash);
      window.removeEventListener('popstate', syncActiveSectionFromHash);
    };
  }, [detail.run.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
      return;
    }

    const pageStack = pageStackRef.current;
    if (!pageStack) {
      return;
    }

    const sectionElements = Array.from(
      pageStack.querySelectorAll<HTMLElement>('[data-run-detail-section]'),
    ).filter((sectionElement) => resolveRunDetailSectionKeyFromElement(sectionElement) !== null);
    if (sectionElements.length === 0) {
      return;
    }

    const observedIntersections = new Map<RunDetailSectionJumpKey, IntersectionObserverEntry>();

    const updateActiveSectionFromIntersections = (): void => {
      const intersectingSections = Array.from(observedIntersections.entries()).filter(
        ([, entry]) => entry.isIntersecting,
      );
      if (intersectingSections.length === 0) {
        return;
      }

      intersectingSections.sort((left, right) => {
        if (right[1].intersectionRatio !== left[1].intersectionRatio) {
          return right[1].intersectionRatio - left[1].intersectionRatio;
        }

        return left[1].boundingClientRect.top - right[1].boundingClientRect.top;
      });

      const nextActiveSection = intersectingSections[0]![0];
      setActiveSection(previous => (previous === nextActiveSection ? previous : nextActiveSection));
    };

    const observer = new window.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sectionKey = resolveRunDetailSectionKeyFromElement(entry.target);
          if (sectionKey === null) {
            continue;
          }

          observedIntersections.set(sectionKey, entry);
        }

        updateActiveSectionFromIntersections();
      },
      {
        threshold: [0, 0.2, 0.35, 0.5, 0.7, 1],
        rootMargin: '-20% 0px -55% 0px',
      },
    );

    for (const sectionElement of sectionElements) {
      observer.observe(sectionElement);
    }

    return () => {
      observer.disconnect();
      observedIntersections.clear();
    };
  }, [detail.run.id]);

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

  const handleSectionJumpNavClickCapture = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const anchor = target.closest('a[href^="#"]');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const sectionKey = resolveRunDetailSectionKeyFromHash(anchor.getAttribute('href') ?? '');
    if (sectionKey !== null) {
      setActiveSection(sectionKey);
    }
  };

  return (
    <div ref={pageStackRef} className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>{pageSubtitle}</p>
      </section>

      <div onClickCapture={handleSectionJumpNavClickCapture}>
        <RunDetailSectionJumpNav activeSection={activeSection} />
      </div>

      <section
        id="run-detail-operator-focus-section"
        className="run-detail-section-anchor run-detail-section-anchor--compact"
        data-run-detail-section="focus"
        aria-labelledby="run-detail-operator-focus-heading"
      >
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
      </section>

      <section
        id="run-detail-timeline-section"
        className="run-detail-section-anchor"
        data-run-detail-section="timeline"
        aria-labelledby="run-detail-timeline-heading"
      >
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
      </section>

      <section
        id="run-detail-stream-section"
        className="run-detail-section-anchor"
        data-run-detail-section="stream"
        aria-labelledby="run-detail-stream-heading"
      >
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
          setStreamAutoScroll={setStreamAutoScroll}
          setStreamBufferedEvents={setStreamBufferedEvents}
          setStreamEvents={setStreamEvents}
        />
      </section>

      <section
        id="run-detail-observability-section"
        className="run-detail-section-anchor"
        data-run-detail-section="observability"
        aria-labelledby="run-detail-observability-heading"
      >
        <RunObservabilityCard detail={detail} />
      </section>
    </div>
  );
}
