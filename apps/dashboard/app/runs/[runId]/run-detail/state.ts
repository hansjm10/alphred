import { isActiveRunStatus } from '../../run-summary-utils';
import type {
  DashboardRunControlAction,
  DashboardRunDetail,
  DashboardRunNodeStreamEvent,
  DashboardRunSummary,
} from '../../../../src/server/dashboard-contracts';
import type {
  ActionFeedbackState,
  AgentStreamConnectionState,
  AgentStreamTarget,
  RealtimeChannelState,
  StateSetter,
} from './types';
import { mergeAgentStreamEvents, resolveInitialAgentStreamTarget, toAgentStreamTarget } from './realtime';

export function syncSelectionStateWithNodes(params: {
  nodes: DashboardRunDetail['nodes'];
  highlightedNodeId: number | null;
  filteredNodeId: number | null;
  streamTarget: AgentStreamTarget | null;
  setHighlightedNodeId: StateSetter<number | null>;
  setFilteredNodeId: StateSetter<number | null>;
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
}): void {
  const {
    nodes,
    highlightedNodeId,
    filteredNodeId,
    streamTarget,
    setHighlightedNodeId,
    setFilteredNodeId,
    setStreamTarget,
  } = params;

  if (highlightedNodeId !== null && !nodes.some((node) => node.id === highlightedNodeId)) {
    setHighlightedNodeId(null);
  }

  if (filteredNodeId !== null && !nodes.some((node) => node.id === filteredNodeId)) {
    setFilteredNodeId(null);
  }

  if (streamTarget === null) {
    return;
  }

  const updatedNode = nodes.find((node) => node.id === streamTarget.runNodeId);
  if (!updatedNode) {
    setStreamTarget(null);
    return;
  }

  if (updatedNode.attempt !== streamTarget.attempt || updatedNode.nodeKey !== streamTarget.nodeKey) {
    setStreamTarget(toAgentStreamTarget(updatedNode));
  }
}

export function isStreamSupportedNodeStatus(status: DashboardRunDetail['nodes'][number]['status']): boolean {
  return status === 'running' || status === 'completed' || status === 'failed';
}

export function isSameStreamTarget(
  currentTarget: AgentStreamTarget | null,
  nextTarget: AgentStreamTarget,
): boolean {
  return (
    currentTarget !== null &&
    currentTarget.runNodeId === nextTarget.runNodeId &&
    currentTarget.attempt === nextTarget.attempt &&
    currentTarget.nodeKey === nextTarget.nodeKey
  );
}

export function syncStreamSelectionForNode(params: {
  node: DashboardRunDetail['nodes'][number];
  streamTarget: AgentStreamTarget | null;
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}): void {
  const { node, streamTarget, setStreamTarget, setStreamAutoScroll, setStreamBufferedEvents } = params;
  if (!isStreamSupportedNodeStatus(node.status)) {
    if (streamTarget !== null) {
      setStreamTarget(null);
      setStreamAutoScroll(true);
      setStreamBufferedEvents([]);
    }
    return;
  }

  const nextStreamTarget = toAgentStreamTarget(node);
  if (isSameStreamTarget(streamTarget, nextStreamTarget)) {
    return;
  }

  setStreamTarget(nextStreamTarget);
  setStreamAutoScroll(true);
  setStreamBufferedEvents([]);
}

export function toggleNodeFilterState(params: {
  nodeId: number;
  filteredNodeId: number | null;
  nodes: DashboardRunDetail['nodes'];
  streamTarget: AgentStreamTarget | null;
  setFilteredNodeId: StateSetter<number | null>;
  setHighlightedNodeId: StateSetter<number | null>;
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}): void {
  const {
    nodeId,
    filteredNodeId,
    nodes,
    streamTarget,
    setFilteredNodeId,
    setHighlightedNodeId,
    setStreamTarget,
    setStreamAutoScroll,
    setStreamBufferedEvents,
  } = params;
  const nextNodeId = filteredNodeId === nodeId ? null : nodeId;
  setFilteredNodeId(nextNodeId);
  setHighlightedNodeId(nextNodeId);

  if (nextNodeId === null) {
    return;
  }

  const selectedNode = nodes.find(node => node.id === nextNodeId);
  if (!selectedNode) {
    return;
  }

  syncStreamSelectionForNode({
    node: selectedNode,
    streamTarget,
    setStreamTarget,
    setStreamAutoScroll,
    setStreamBufferedEvents,
  });
}


export function resetRunDetailStateFromInitialDetail(params: {
  initialDetail: DashboardRunDetail;
  enableRealtime: boolean;
  streamLastSequenceRef: { current: number };
  setDetail: StateSetter<DashboardRunDetail>;
  setUpdateError: StateSetter<string | null>;
  setIsRefreshing: StateSetter<boolean>;
  setNextRetryAtMs: StateSetter<number | null>;
  setRetryCountdownSeconds: StateSetter<number | null>;
  setLastUpdatedAtMs: StateSetter<number>;
  setChannelState: StateSetter<RealtimeChannelState>;
  setStreamTarget: StateSetter<AgentStreamTarget | null>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamConnectionState: StateSetter<AgentStreamConnectionState>;
  setStreamError: StateSetter<string | null>;
  setStreamNextRetryAtMs: StateSetter<number | null>;
  setStreamRetryCountdownSeconds: StateSetter<number | null>;
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamLastUpdatedAtMs: StateSetter<number>;
  setPendingControlAction: StateSetter<DashboardRunControlAction | null>;
  setActionFeedback: StateSetter<ActionFeedbackState>;
}): void {
  const {
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
  } = params;

  setDetail(initialDetail);
  setUpdateError(null);
  setIsRefreshing(false);
  setNextRetryAtMs(null);
  setRetryCountdownSeconds(null);
  setLastUpdatedAtMs(Date.now());
  setChannelState(enableRealtime && isActiveRunStatus(initialDetail.run.status) ? 'live' : 'disabled');
  setStreamTarget(resolveInitialAgentStreamTarget(initialDetail));
  setStreamEvents([]);
  setStreamBufferedEvents([]);
  setStreamConnectionState('ended');
  setStreamError(null);
  setStreamNextRetryAtMs(null);
  setStreamRetryCountdownSeconds(null);
  setStreamAutoScroll(true);
  setStreamLastUpdatedAtMs(Date.now());
  setPendingControlAction(null);
  setActionFeedback(null);
  streamLastSequenceRef.current = 0;
}

export function flushBufferedAgentStreamEvents(params: {
  streamAutoScroll: boolean;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}): void {
  const { streamAutoScroll, streamBufferedEvents, setStreamEvents, setStreamBufferedEvents } = params;
  if (!streamAutoScroll || streamBufferedEvents.length === 0) {
    return;
  }

  setStreamEvents(previous => mergeAgentStreamEvents(previous, streamBufferedEvents));
  setStreamBufferedEvents([]);
}

export function syncStreamEventListScroll(params: {
  streamAutoScroll: boolean;
  streamEventListRef: { current: HTMLOListElement | null };
}): void {
  const { streamAutoScroll, streamEventListRef } = params;
  if (!streamAutoScroll || streamEventListRef.current === null) {
    return;
  }

  streamEventListRef.current.scrollTop = streamEventListRef.current.scrollHeight;
}

export function createRetryCountdownEffect(params: {
  retryAtMs: number | null;
  setRetryCountdownSeconds: StateSetter<number | null>;
}): () => void {
  const { retryAtMs, setRetryCountdownSeconds } = params;
  if (retryAtMs === null) {
    setRetryCountdownSeconds(null);
    return () => undefined;
  }

  const updateCountdown = (): void => {
    const remainingSeconds = Math.max(0, Math.ceil((retryAtMs - Date.now()) / 1000));
    setRetryCountdownSeconds(remainingSeconds);
  };

  updateCountdown();
  const intervalId = globalThis.setInterval(updateCountdown, 250);
  return () => {
    clearInterval(intervalId);
  };
}

export function clearActionFeedbackOnStatusChange(params: {
  runStatus: DashboardRunSummary['status'];
  setActionFeedback: StateSetter<ActionFeedbackState>;
}): void {
  const { runStatus, setActionFeedback } = params;
  setActionFeedback((current) => {
    if (current === null || current.runStatus === null || current.runStatus === runStatus) {
      return current;
    }

    return null;
  });
}

