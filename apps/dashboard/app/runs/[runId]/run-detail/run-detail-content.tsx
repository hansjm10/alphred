'use client';

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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

type RunDetailSectionId = 'focus' | 'timeline' | 'stream' | 'observability';

type RunDetailSection = Readonly<{
  id: RunDetailSectionId;
  label: string;
  headingId: string;
}>;

type SectionIntersectionSnapshot = Readonly<{
  id: RunDetailSectionId;
  isIntersecting: boolean;
  top: number;
  ratio: number;
}>;

const RUN_DETAIL_SECTIONS: readonly RunDetailSection[] = [
  {
    id: 'focus',
    label: 'Focus',
    headingId: 'run-focus-heading',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    headingId: 'run-timeline-heading',
  },
  {
    id: 'stream',
    label: 'Stream',
    headingId: 'run-stream-heading',
  },
  {
    id: 'observability',
    label: 'Observability',
    headingId: 'run-observability-heading',
  },
];

const RUN_DETAIL_SECTION_ID_LOOKUP: ReadonlySet<RunDetailSectionId> = new Set(
  RUN_DETAIL_SECTIONS.map((section) => section.id),
);
const RUN_DETAIL_SECTION_OBSERVER_TOP_OFFSET_PX = 120;
const RUN_DETAIL_SECTION_OBSERVER_OPTIONS = {
  root: null,
  rootMargin: '-112px 0px -45% 0px',
  threshold: [0, 0.25, 0.5, 0.75, 1],
} satisfies IntersectionObserverInit;

function isRunDetailSectionId(value: string): value is RunDetailSectionId {
  return RUN_DETAIL_SECTION_ID_LOOKUP.has(value as RunDetailSectionId);
}

function resolveSectionIdFromHash(hash: string): RunDetailSectionId | null {
  const sectionId = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!isRunDetailSectionId(sectionId)) {
    return null;
  }

  return sectionId;
}

function resolveActiveSectionFromIntersections(
  sectionSnapshots: ReadonlyMap<RunDetailSectionId, SectionIntersectionSnapshot>,
): RunDetailSectionId | null {
  const intersectingSections = RUN_DETAIL_SECTIONS.map((section, index) => {
    const snapshot = sectionSnapshots.get(section.id);
    if (!snapshot || !snapshot.isIntersecting) {
      return null;
    }

    return {
      id: snapshot.id,
      top: snapshot.top,
      ratio: snapshot.ratio,
      index,
    };
  }).filter((snapshot): snapshot is { id: RunDetailSectionId; top: number; ratio: number; index: number } => snapshot !== null);

  if (intersectingSections.length === 0) {
    return null;
  }

  const sortedIntersections = [...intersectingSections].sort((left, right) => {
    if (left.top !== right.top) {
      return left.top - right.top;
    }
    if (left.ratio !== right.ratio) {
      return right.ratio - left.ratio;
    }

    return left.index - right.index;
  });
  const crossedTopOffset = sortedIntersections.filter(
    (section) => section.top <= RUN_DETAIL_SECTION_OBSERVER_TOP_OFFSET_PX,
  );

  return (crossedTopOffset.at(-1) ?? sortedIntersections[0]).id;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  const [activeSectionId, setActiveSectionId] = useState<RunDetailSectionId>(RUN_DETAIL_SECTIONS[0].id);

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

    const hashSectionId = resolveSectionIdFromHash(window.location.hash);
    if (hashSectionId) {
      setActiveSectionId(hashSectionId);
    }

    const handleHashChange = (): void => {
      const nextSectionId = resolveSectionIdFromHash(window.location.hash);
      if (nextSectionId) {
        setActiveSectionId(nextSectionId);
      }
    };

    window.addEventListener('hashchange', handleHashChange);

    if (typeof window.IntersectionObserver !== 'function') {
      return () => {
        window.removeEventListener('hashchange', handleHashChange);
      };
    }

    const sectionSnapshots = new Map<RunDetailSectionId, SectionIntersectionSnapshot>();
    const observer = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        const sectionId = entry.target.id;
        if (!isRunDetailSectionId(sectionId)) {
          continue;
        }

        sectionSnapshots.set(sectionId, {
          id: sectionId,
          isIntersecting: entry.isIntersecting,
          top: entry.boundingClientRect.top,
          ratio: entry.intersectionRatio,
        });
      }

      const nextActiveSectionId = resolveActiveSectionFromIntersections(sectionSnapshots);
      if (nextActiveSectionId) {
        setActiveSectionId(nextActiveSectionId);
      }
    }, RUN_DETAIL_SECTION_OBSERVER_OPTIONS);

    const observedSections: HTMLElement[] = [];
    for (const section of RUN_DETAIL_SECTIONS) {
      const sectionElement = document.getElementById(section.id);
      if (!sectionElement) {
        continue;
      }

      sectionSnapshots.set(section.id, {
        id: section.id,
        isIntersecting: false,
        top: Number.POSITIVE_INFINITY,
        ratio: 0,
      });
      observer.observe(sectionElement);
      observedSections.push(sectionElement);
    }

    return () => {
      for (const sectionElement of observedSections) {
        observer.unobserve(sectionElement);
      }
      observer.disconnect();
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

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

  const handleSectionNavigationClick = (
    event: MouseEvent<HTMLAnchorElement>,
    sectionId: RunDetailSectionId,
  ): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const sectionElement = document.getElementById(sectionId);
    if (!sectionElement) {
      return;
    }

    event.preventDefault();
    setActiveSectionId(sectionId);

    if (typeof sectionElement.scrollIntoView === 'function') {
      sectionElement.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
    }

    const targetHash = `#${sectionId}`;
    if (window.location.hash !== targetHash) {
      if (typeof window.history.pushState === 'function') {
        window.history.pushState(null, '', targetHash);
      } else {
        window.location.hash = sectionId;
      }
    }
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>{pageSubtitle}</p>
      </section>

      <nav aria-label="Run detail sections" className="run-detail-section-nav">
        <ul className="run-detail-section-nav__list">
          {RUN_DETAIL_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="run-detail-section-nav__link"
                aria-current={activeSectionId === section.id ? 'location' : undefined}
                onClick={(event) => {
                  handleSectionNavigationClick(event, section.id);
                }}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section id={RUN_DETAIL_SECTIONS[0].id} aria-labelledby={RUN_DETAIL_SECTIONS[0].headingId} className="run-detail-section">
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

      <section id={RUN_DETAIL_SECTIONS[1].id} aria-labelledby={RUN_DETAIL_SECTIONS[1].headingId} className="run-detail-section">
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

      <section id={RUN_DETAIL_SECTIONS[2].id} aria-labelledby={RUN_DETAIL_SECTIONS[2].headingId} className="run-detail-section">
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

      <section id={RUN_DETAIL_SECTIONS[3].id} aria-labelledby={RUN_DETAIL_SECTIONS[3].headingId} className="run-detail-section">
        <RunObservabilityCard detail={detail} />
      </section>
    </div>
  );
}
