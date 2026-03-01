import { describe, expect, it } from 'vitest';
import type { DashboardRunDetail, DashboardRunNodeStreamEvent } from '../../../../src/server/dashboard-contracts';
import type { StateSetter } from './types';
import { flushBufferedAgentStreamEvents, toggleNodeFilterState } from './state';

function createNode(overrides: Partial<DashboardRunDetail['nodes'][number]> = {}): DashboardRunDetail['nodes'][number] {
  return {
    id: overrides.id ?? 1,
    treeNodeId: overrides.treeNodeId ?? 1,
    nodeKey: overrides.nodeKey ?? 'design',
    nodeRole: overrides.nodeRole ?? 'standard',
    spawnerNodeId: overrides.spawnerNodeId ?? null,
    joinNodeId: overrides.joinNodeId ?? null,
    lineageDepth: overrides.lineageDepth ?? 0,
    sequencePath: overrides.sequencePath ?? null,
    sequenceIndex: overrides.sequenceIndex ?? 0,
    attempt: overrides.attempt ?? 1,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    latestArtifact: overrides.latestArtifact ?? null,
    latestRoutingDecision: overrides.latestRoutingDecision ?? null,
    latestDiagnostics: overrides.latestDiagnostics ?? null,
  };
}

function createStreamEvent(
  sequence: number,
  overrides: Partial<DashboardRunNodeStreamEvent> = {},
): DashboardRunNodeStreamEvent {
  return {
    id: overrides.id ?? sequence,
    workflowRunId: overrides.workflowRunId ?? 412,
    runNodeId: overrides.runNodeId ?? 1,
    attempt: overrides.attempt ?? 1,
    sequence,
    type: overrides.type ?? 'assistant',
    timestamp: overrides.timestamp ?? sequence,
    contentChars: overrides.contentChars ?? 8,
    contentPreview: overrides.contentPreview ?? `event ${sequence}`,
    metadata: overrides.metadata ?? null,
    usage: overrides.usage ?? null,
    createdAt: overrides.createdAt ?? '2026-02-18T00:00:40.000Z',
  };
}

function createSetterTracker<T>(initialValue: T): Readonly<{
  setter: StateSetter<T>;
  updates: T[];
  getCurrent: () => T;
}> {
  let current = initialValue;
  const updates: T[] = [];

  const setter: StateSetter<T> = (nextValue) => {
    if (typeof nextValue === 'function') {
      current = (nextValue as (previousValue: T) => T)(current);
    } else {
      current = nextValue;
    }
    updates.push(current);
  };

  return {
    setter,
    updates,
    getCurrent: () => current,
  };
}

describe('toggleNodeFilterState', () => {
  it('keeps stream state unchanged when requested node is missing from current detail', () => {
    const filteredNode = createSetterTracker<number | null>(null);
    const highlightedNode = createSetterTracker<number | null>(null);
    const streamTarget = createSetterTracker<{ runNodeId: number; nodeKey: string; attempt: number } | null>({
      runNodeId: 1,
      nodeKey: 'design',
      attempt: 1,
    });
    const streamAutoScroll = createSetterTracker<boolean>(false);
    const streamBufferedEvents = createSetterTracker<DashboardRunNodeStreamEvent[]>([
      createStreamEvent(1, { contentPreview: 'buffered' }),
    ]);

    toggleNodeFilterState({
      nodeId: 99,
      filteredNodeId: null,
      nodes: [createNode({ id: 1 })],
      streamTarget: streamTarget.getCurrent(),
      setFilteredNodeId: filteredNode.setter,
      setHighlightedNodeId: highlightedNode.setter,
      setStreamTarget: streamTarget.setter,
      setStreamAutoScroll: streamAutoScroll.setter,
      setStreamBufferedEvents: streamBufferedEvents.setter,
    });

    expect(filteredNode.updates).toEqual([99]);
    expect(highlightedNode.updates).toEqual([99]);
    expect(streamTarget.updates).toHaveLength(0);
    expect(streamAutoScroll.updates).toHaveLength(0);
    expect(streamBufferedEvents.updates).toHaveLength(0);
  });
});

describe('flushBufferedAgentStreamEvents', () => {
  it('merges buffered events into the visible stream and clears the buffer', () => {
    const streamEvents = createSetterTracker<DashboardRunNodeStreamEvent[]>([
      createStreamEvent(1, { id: 1, contentPreview: 'original event' }),
    ]);
    const streamBufferedEvents = createSetterTracker<DashboardRunNodeStreamEvent[]>([
      createStreamEvent(1, { id: 2, contentPreview: 'replacement event' }),
      createStreamEvent(2, { id: 3, contentPreview: 'new event' }),
    ]);

    flushBufferedAgentStreamEvents({
      streamAutoScroll: true,
      streamBufferedEvents: streamBufferedEvents.getCurrent(),
      setStreamEvents: streamEvents.setter,
      setStreamBufferedEvents: streamBufferedEvents.setter,
    });

    expect(streamEvents.getCurrent()).toEqual([
      createStreamEvent(1, { id: 2, contentPreview: 'replacement event' }),
      createStreamEvent(2, { id: 3, contentPreview: 'new event' }),
    ]);
    expect(streamBufferedEvents.getCurrent()).toEqual([]);
  });
});
