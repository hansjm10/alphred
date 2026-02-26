import { ActionButton, Card } from '../../../ui/primitives';
import type { DashboardRunDetail, DashboardRunNodeStreamEvent } from '../../../../src/server/dashboard-contracts';
import type { ReactNode } from 'react';
import { ExpandablePreview } from './expandable-preview';
import { formatLastUpdated, formatStreamTimestamp } from './formatting';
import { mergeAgentStreamEvents } from './realtime';
import { partitionByRecency } from './timeline';
import {
  RUN_AGENT_STREAM_RECENT_EVENT_COUNT,
  type AgentStreamConnectionState,
  type RecentPartition,
  type StateSetter,
} from './types';

type StreamEventItemsProps = Readonly<{
  partition: RecentPartition<DashboardRunNodeStreamEvent>;
  renderEvent: (event: DashboardRunNodeStreamEvent) => ReactNode;
}>;

export function StreamEventItems({ partition, renderEvent }: StreamEventItemsProps) {
  if (partition.earlier.length === 0 && partition.recent.length === 0) {
    return (
      <li>
        <p>No streamed events captured yet for this node attempt.</p>
      </li>
    );
  }

  return (
    <>
      {partition.earlier.length > 0 ? (
        <li>
          <details className="run-collapsible-history">
            <summary className="run-collapsible-history__summary">
              {`Show ${partition.earlier.length} earlier stream events`}
            </summary>
            <ol className="page-stack run-collapsible-history__list" aria-label="Earlier agent stream events">
              {partition.earlier.map((event) => renderEvent(event))}
            </ol>
          </details>
        </li>
      ) : null}
      {partition.recent.map((event) => renderEvent(event))}
    </>
  );
}

type RunAgentStreamCardProps = Readonly<{
  isTerminalRun: boolean;
  selectedStreamNode: DashboardRunDetail['nodes'][number] | null;
  agentStreamLabel: {
    badgeLabel: string;
    detail: string;
  };
  streamConnectionState: AgentStreamConnectionState;
  streamLastUpdatedAtMs: number;
  hasHydrated: boolean;
  streamAutoScroll: boolean;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  streamError: string | null;
  streamEvents: readonly DashboardRunNodeStreamEvent[];
  streamEventListRef: { current: HTMLOListElement | null };
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}>;

export function RunAgentStreamCard({
  isTerminalRun,
  selectedStreamNode,
  agentStreamLabel,
  streamConnectionState,
  streamLastUpdatedAtMs,
  hasHydrated,
  streamAutoScroll,
  streamBufferedEvents,
  streamError,
  streamEvents,
  streamEventListRef,
  setStreamAutoScroll,
  setStreamBufferedEvents,
  setStreamEvents,
}: RunAgentStreamCardProps) {
  const streamEventPartition = partitionByRecency(streamEvents, RUN_AGENT_STREAM_RECENT_EVENT_COUNT);

  const renderStreamEvent = (event: DashboardRunNodeStreamEvent) => (
    <li key={`${event.runNodeId}-${event.attempt}-${event.sequence}`} className="run-agent-stream-event">
      <p className="meta-text">{`#${event.sequence} · ${formatStreamTimestamp(event.timestamp)}`}</p>
      <p>
        <span className={`run-agent-stream-event-type run-agent-stream-event-type--${event.type}`}>{event.type}</span>
      </p>
      <ExpandablePreview
        value={event.contentPreview}
        label="event payload"
        previewLength={160}
        className="run-agent-stream-event-content"
      />
      {event.metadata ? (
        <details>
          <summary>metadata</summary>
          <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
        </details>
      ) : null}
      {event.usage ? (
        <p className="meta-text">
          {`Usage Δ ${event.usage.deltaTokens ?? 'n/a'} · cumulative ${event.usage.cumulativeTokens ?? 'n/a'}`}
        </p>
      ) : null}
    </li>
  );

  const streamContent = selectedStreamNode ? (
    <>
      <output className={`run-realtime-status run-realtime-status--${streamConnectionState}`} aria-live="polite">
        <span className="run-realtime-status__badge">{agentStreamLabel.badgeLabel}</span>
        <span className="meta-text">{agentStreamLabel.detail}</span>
        <span className="meta-text">
          {`Node ${selectedStreamNode.nodeKey} (attempt ${selectedStreamNode.attempt}) · last update ${formatLastUpdated(streamLastUpdatedAtMs, hasHydrated)}.`}
        </span>
      </output>

      <div className="action-row run-agent-stream-controls">
        <ActionButton
          onClick={() => {
            if (streamAutoScroll) {
              setStreamAutoScroll(false);
              return;
            }

            setStreamAutoScroll(true);
            setStreamEvents(previous => mergeAgentStreamEvents(previous, streamBufferedEvents));
            setStreamBufferedEvents([]);
          }}
        >
          {streamAutoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
        </ActionButton>
        {streamBufferedEvents.length > 0 ? (
          <span className="meta-text">{`${streamBufferedEvents.length} new events buffered.`}</span>
        ) : null}
      </div>

      {streamError && (streamConnectionState === 'reconnecting' || streamConnectionState === 'stale') ? (
        <output className="run-realtime-warning" aria-live="polite">
          {`Agent stream degraded: ${streamError}`}
        </output>
      ) : null}

      <ol ref={streamEventListRef} className="page-stack run-agent-stream-events" aria-label="Agent stream events">
        <StreamEventItems partition={streamEventPartition} renderEvent={renderStreamEvent} />
      </ol>
    </>
  ) : (
    <p>Select a node from Node Status to open its agent stream.</p>
  );

  if (isTerminalRun) {
    const streamTargetLabel = selectedStreamNode
      ? `${selectedStreamNode.nodeKey} (attempt ${selectedStreamNode.attempt})`
      : 'no target selected';
    const capturedEventCount = (
      streamBufferedEvents.length === 0
        ? streamEvents
        : mergeAgentStreamEvents(streamEvents, streamBufferedEvents)
    ).length;
    const eventSuffix = capturedEventCount === 1 ? '' : 's';
    const eventCountLabel = capturedEventCount > 0
      ? `${capturedEventCount} event${eventSuffix} captured`
      : 'no events captured';

    return (
      <Card title="Agent stream" description="Provider events for a selected node attempt.">
        <details className="run-agent-stream-collapsed">
          <summary className="run-agent-stream-collapsed__summary">
            {`Stream ended · ${streamTargetLabel} · ${eventCountLabel}`}
          </summary>
          {streamContent}
        </details>
      </Card>
    );
  }

  return (
    <Card title="Agent stream" description="Live provider events for a selected node attempt.">
      {streamContent}
    </Card>
  );
}
