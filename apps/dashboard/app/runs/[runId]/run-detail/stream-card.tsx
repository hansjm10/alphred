import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ActionButton, Card } from '../../../ui/primitives';
import type { DashboardRunDetail, DashboardRunNodeStreamEvent } from '../../../../src/server/dashboard-contracts';
import { formatLastUpdated, formatStreamTimestamp } from './formatting';
import { mergeAgentStreamEvents } from './realtime';
import {
  type AgentStreamConnectionState,
  type StateSetter,
} from './types';

type StreamEventFilter = 'all' | DashboardRunNodeStreamEvent['type'];
type InspectorPayloadMode = 'pretty' | 'raw' | 'markdown';

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
  selectedEventSequence: number | null;
  onSelectedEventSequenceChange: (sequence: number | null) => void;
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}>;

type ToggleStreamAutoScrollInput = Readonly<{
  streamAutoScroll: boolean;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  setStreamAutoScroll: StateSetter<boolean>;
  setStreamBufferedEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
  setStreamEvents: StateSetter<DashboardRunNodeStreamEvent[]>;
}>;

type TerminalStreamSummaryInput = Readonly<{
  selectedStreamNode: DashboardRunDetail['nodes'][number] | null;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  streamEvents: readonly DashboardRunNodeStreamEvent[];
}>;

const STREAM_EVENT_WINDOW_SIZE = 120;
const STREAM_EVENT_SUMMARY_MAX_CHARS = 120;
const STREAM_EVENT_FILTER_OPTIONS: readonly Readonly<{ value: StreamEventFilter; label: string }>[] = [
  { value: 'all', label: 'All types' },
  { value: 'system', label: 'system' },
  { value: 'assistant', label: 'assistant' },
  { value: 'tool_use', label: 'tool_use' },
  { value: 'tool_result', label: 'tool_result' },
  { value: 'usage', label: 'usage' },
  { value: 'result', label: 'result' },
];

function toggleStreamAutoScroll({
  streamAutoScroll,
  streamBufferedEvents,
  setStreamAutoScroll,
  setStreamBufferedEvents,
  setStreamEvents,
}: ToggleStreamAutoScrollInput) {
  if (streamAutoScroll) {
    setStreamAutoScroll(false);
    return;
  }

  setStreamAutoScroll(true);
  setStreamEvents(previous => mergeAgentStreamEvents(previous, streamBufferedEvents));
  setStreamBufferedEvents([]);
}

function formatTerminalStreamSummary({
  selectedStreamNode,
  streamBufferedEvents,
  streamEvents,
}: TerminalStreamSummaryInput): string {
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
  return `Stream ended · ${streamTargetLabel} · ${eventCountLabel}`;
}

function formatEventSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= STREAM_EVENT_SUMMARY_MAX_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, STREAM_EVENT_SUMMARY_MAX_CHARS)}...`;
}

function eventMatchesInspectorFilter(event: DashboardRunNodeStreamEvent, filter: StreamEventFilter, query: string): boolean {
  if (filter !== 'all' && event.type !== filter) {
    return false;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  const metadataText = event.metadata ? JSON.stringify(event.metadata).toLowerCase() : '';
  return (
    event.contentPreview.toLowerCase().includes(normalizedQuery) ||
    metadataText.includes(normalizedQuery) ||
    event.type.toLowerCase().includes(normalizedQuery)
  );
}

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function flattenMetadata(metadata: Record<string, unknown> | null): readonly (readonly [string, string])[] {
  if (!metadata) {
    return [];
  }

  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, stringifyMetadataValue(value)] as const);
}

function parseJsonPayload(payload: string): unknown | null {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function sanitizeCodeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function highlightJsonCode(jsonText: string): string {
  const sanitized = sanitizeCodeText(jsonText);

  return sanitized.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, quotedLiteral, isKeySuffix, booleanLiteral) => {
      if (quotedLiteral) {
        const className = isKeySuffix ? 'run-agent-inspector-token--key' : 'run-agent-inspector-token--string';
        return `<span class="${className}">${match}</span>`;
      }
      if (booleanLiteral) {
        return `<span class="run-agent-inspector-token--boolean">${match}</span>`;
      }
      if (match === 'null') {
        return `<span class="run-agent-inspector-token--null">${match}</span>`;
      }
      return `<span class="run-agent-inspector-token--number">${match}</span>`;
    },
  );
}

function isLikelyMarkdown(value: string): boolean {
  return /(^#{1,6}\s)|(^[-*]\s)|(^\d+\.\s)|(```)|\[[^\]]+\]\([^)]+\)/m.test(value);
}

function renderMarkdownPayload(value: string): ReactNode {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return <p className="meta-text">Payload is empty.</p>;
  }

  const blocks = normalized.split(/\n{2,}/);

  return blocks.map((block, blockIndex) => {
    if (block.startsWith('```') && block.endsWith('```')) {
      const codeContent = block
        .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
        .replace(/\n?```$/, '');
      return (
        <pre key={`md-code-${blockIndex}`} className="code-preview run-agent-inspector-markdown-code">
          <code>{codeContent}</code>
        </pre>
      );
    }

    const lines = block.split('\n');

    const headingMatch = lines[0]?.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const text = headingMatch[2].trim();
      const headingDepth = headingMatch[1].length;
      if (headingDepth <= 2) {
        return <h4 key={`md-heading-${blockIndex}`}>{text}</h4>;
      }
      return <h5 key={`md-heading-${blockIndex}`}>{text}</h5>;
    }

    if (lines.every(line => /^[-*]\s+/.test(line.trim()))) {
      return (
        <ul key={`md-list-${blockIndex}`} className="run-agent-inspector-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`md-li-${blockIndex}-${lineIndex}`}>{line.replace(/^[-*]\s+/, '')}</li>
          ))}
        </ul>
      );
    }

    if (lines.every(line => /^\d+\.\s+/.test(line.trim()))) {
      return (
        <ol key={`md-ol-${blockIndex}`} className="run-agent-inspector-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`md-oli-${blockIndex}-${lineIndex}`}>{line.replace(/^\d+\.\s+/, '')}</li>
          ))}
        </ol>
      );
    }

    return (
      <p key={`md-paragraph-${blockIndex}`}>
        {lines.map((line, lineIndex) => (
          <span key={`md-span-${blockIndex}-${lineIndex}`}>
            {line}
            {lineIndex < lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  });
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    return false;
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function downloadEventPayload(event: DashboardRunNodeStreamEvent): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return;
  }

  const parsedPayload = parseJsonPayload(event.contentPreview);
  const payload = {
    ...event,
    payload: parsedPayload ?? event.contentPreview,
    truncated: event.contentPreview.length < event.contentChars,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `run-${event.workflowRunId}-node-${event.runNodeId}-attempt-${event.attempt}-event-${event.sequence}.json`;
  document.body.append(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(blobUrl);
}

function EventListPane(props: Readonly<{
  streamEvents: readonly DashboardRunNodeStreamEvent[];
  streamEventListRef: { current: HTMLOListElement | null };
  selectedEventSequence: number | null;
  onSelectedEventSequenceChange: (sequence: number | null) => void;
  streamConnectionState: AgentStreamConnectionState;
  eventTypeFilter: StreamEventFilter;
  setEventTypeFilter: StateSetter<StreamEventFilter>;
  eventSearchQuery: string;
  setEventSearchQuery: StateSetter<string>;
  visibleEventCount: number;
  setVisibleEventCount: StateSetter<number>;
  streamAutoScroll: boolean;
  streamBufferedEvents: readonly DashboardRunNodeStreamEvent[];
  onToggleAutoScroll: () => void;
}>) {
  const {
    streamEvents,
    streamEventListRef,
    selectedEventSequence,
    onSelectedEventSequenceChange,
    streamConnectionState,
    eventTypeFilter,
    setEventTypeFilter,
    eventSearchQuery,
    setEventSearchQuery,
    visibleEventCount,
    setVisibleEventCount,
    streamAutoScroll,
    streamBufferedEvents,
    onToggleAutoScroll,
  } = props;

  const eventButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const hasLoadedStreamEventsRef = useRef<boolean>(streamEvents.length > 0);
  const hasStartedStreamInitializationRef = useRef<boolean>(streamEvents.length > 0);

  const filteredEvents = useMemo(
    () => streamEvents.filter(event => eventMatchesInspectorFilter(event, eventTypeFilter, eventSearchQuery)),
    [eventSearchQuery, eventTypeFilter, streamEvents],
  );

  const visibleEvents = useMemo(() => {
    if (filteredEvents.length <= visibleEventCount) {
      return filteredEvents;
    }

    return filteredEvents.slice(-visibleEventCount);
  }, [filteredEvents, visibleEventCount]);

  const hiddenEventCount = Math.max(filteredEvents.length - visibleEvents.length, 0);

  useEffect(() => {
    if (streamEvents.length > 0) {
      hasLoadedStreamEventsRef.current = true;
      hasStartedStreamInitializationRef.current = true;
    }
  }, [streamEvents.length]);

  useEffect(() => {
    if (streamConnectionState !== 'ended') {
      hasStartedStreamInitializationRef.current = true;
    }
  }, [streamConnectionState]);

  useEffect(() => {
    if (filteredEvents.length === 0) {
      const waitingForInitialStreamLoad =
        selectedEventSequence !== null &&
        !hasLoadedStreamEventsRef.current &&
        (!hasStartedStreamInitializationRef.current || streamConnectionState === 'reconnecting');
      if (waitingForInitialStreamLoad) {
        return;
      }
      onSelectedEventSequenceChange(null);
      return;
    }

    const hasSelectedEvent =
      selectedEventSequence !== null && filteredEvents.some(event => event.sequence === selectedEventSequence);

    if (hasSelectedEvent) {
      return;
    }

    onSelectedEventSequenceChange(filteredEvents.at(-1)?.sequence ?? null);
  }, [filteredEvents, onSelectedEventSequenceChange, selectedEventSequence, streamConnectionState]);

  useEffect(() => {
    if (selectedEventSequence === null) {
      return;
    }

    const selectedIsVisible = visibleEvents.some(event => event.sequence === selectedEventSequence);
    if (selectedIsVisible) {
      return;
    }

    if (filteredEvents.some(event => event.sequence === selectedEventSequence)) {
      setVisibleEventCount(filteredEvents.length);
    }
  }, [filteredEvents, selectedEventSequence, setVisibleEventCount, visibleEvents]);

  const jumpToFirst = (): void => {
    const firstEvent = filteredEvents[0];
    if (!firstEvent) {
      return;
    }

    setVisibleEventCount(filteredEvents.length);
    onSelectedEventSequenceChange(firstEvent.sequence);
  };

  const jumpToLast = (): void => {
    const lastEvent = filteredEvents.at(-1);
    if (!lastEvent) {
      return;
    }

    onSelectedEventSequenceChange(lastEvent.sequence);
  };

  const handleListKeyDown = (keyboardEvent: KeyboardEvent<HTMLOListElement>): void => {
    if (visibleEvents.length === 0) {
      return;
    }

    const selectedIndex =
      selectedEventSequence === null
        ? -1
        : visibleEvents.findIndex(event => event.sequence === selectedEventSequence);
    const startIndex = selectedIndex === -1 ? visibleEvents.length - 1 : selectedIndex;

    let nextIndex: number | null = null;
    if (keyboardEvent.key === 'ArrowDown') {
      nextIndex = Math.min(startIndex + 1, visibleEvents.length - 1);
    } else if (keyboardEvent.key === 'ArrowUp') {
      nextIndex = Math.max(startIndex - 1, 0);
    } else if (keyboardEvent.key === 'Home') {
      nextIndex = 0;
    } else if (keyboardEvent.key === 'End') {
      nextIndex = visibleEvents.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    keyboardEvent.preventDefault();
    const nextEvent = visibleEvents[nextIndex];
    if (!nextEvent) {
      return;
    }

    onSelectedEventSequenceChange(nextEvent.sequence);
    eventButtonRefs.current.get(nextEvent.sequence)?.focus();
  };

  return (
    <section className="run-agent-inspector-pane run-agent-inspector-pane--events" aria-label="Agent stream inspector events">
      <div className="action-row run-agent-stream-controls">
        <ActionButton onClick={onToggleAutoScroll}>
          {streamAutoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
        </ActionButton>
        <ActionButton onClick={jumpToFirst} disabled={filteredEvents.length === 0}>Jump to first</ActionButton>
        <ActionButton onClick={jumpToLast} disabled={filteredEvents.length === 0}>Jump to last</ActionButton>
        {streamBufferedEvents.length > 0 ? (
          <span className="meta-text">{`${streamBufferedEvents.length} new events buffered.`}</span>
        ) : null}
      </div>

      <div className="run-agent-inspector-search-row">
        <label className="run-agent-inspector-field">
          <span className="meta-text">Type</span>
          <select
            value={eventTypeFilter}
            onChange={event => setEventTypeFilter(event.target.value as StreamEventFilter)}
            aria-label="Agent stream event type filter"
          >
            {STREAM_EVENT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="run-agent-inspector-field run-agent-inspector-field--search">
          <span className="meta-text">Search</span>
          <input
            value={eventSearchQuery}
            onChange={event => setEventSearchQuery(event.target.value)}
            placeholder="Search payload or metadata"
            aria-label="Search agent stream events"
          />
        </label>
      </div>

      {hiddenEventCount > 0 ? (
        <div className="action-row run-agent-inspector-windowing">
          <span className="meta-text">{`Showing ${visibleEvents.length} of ${filteredEvents.length} matching events.`}</span>
          <ActionButton onClick={() => setVisibleEventCount(filteredEvents.length)}>
            {`Load ${hiddenEventCount} older events`}
          </ActionButton>
        </div>
      ) : null}

      <ol
        ref={streamEventListRef}
        className="page-stack run-agent-stream-events"
        aria-label="Agent stream events"
        onKeyDown={handleListKeyDown}
      >
        {visibleEvents.length === 0 ? (
          <li>
            <p>{streamEvents.length === 0 ? 'No streamed events captured yet for this node attempt.' : 'No events match current filters.'}</p>
          </li>
        ) : (
          visibleEvents.map((event) => {
            const selected = selectedEventSequence === event.sequence;
            const eventSummary = formatEventSummary(event.contentPreview);

            return (
              <li key={`${event.runNodeId}-${event.attempt}-${event.sequence}`} className="run-agent-stream-event">
                <button
                  ref={(node) => {
                    if (node) {
                      eventButtonRefs.current.set(event.sequence, node);
                    } else {
                      eventButtonRefs.current.delete(event.sequence);
                    }
                  }}
                  type="button"
                  className={`run-agent-inspector-event${selected ? ' run-agent-inspector-event--selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => {
                    onSelectedEventSequenceChange(event.sequence);
                  }}
                >
                  <span className="run-agent-inspector-event__header">
                    <span className={`run-agent-stream-event-type run-agent-stream-event-type--${event.type}`}>{event.type}</span>
                    <span className="meta-text">{`#${event.sequence} · ${formatStreamTimestamp(event.timestamp)}`}</span>
                  </span>
                  <span className="run-agent-inspector-event__summary">{eventSummary || '(empty payload)'}</span>
                </button>
              </li>
            );
          })
        )}
      </ol>
    </section>
  );
}

function DetailPane(props: Readonly<{
  selectedEvent: DashboardRunNodeStreamEvent | null;
  payloadMode: InspectorPayloadMode;
  setPayloadMode: StateSetter<InspectorPayloadMode>;
  wrapPayloadLines: boolean;
  setWrapPayloadLines: StateSetter<boolean>;
  utilityFeedback: string | null;
  setUtilityFeedback: StateSetter<string | null>;
}>) {
  const {
    selectedEvent,
    payloadMode,
    setPayloadMode,
    wrapPayloadLines,
    setWrapPayloadLines,
    utilityFeedback,
    setUtilityFeedback,
  } = props;

  const metadataRows = useMemo(
    () => flattenMetadata(selectedEvent?.metadata ?? null),
    [selectedEvent?.metadata],
  );

  const parsedPrettyPayload = useMemo(() => {
    if (!selectedEvent) {
      return null;
    }

    return parseJsonPayload(selectedEvent.contentPreview);
  }, [selectedEvent]);

  const prettyPayloadText = useMemo(() => {
    if (!selectedEvent || parsedPrettyPayload === null) {
      return null;
    }

    return JSON.stringify(parsedPrettyPayload, null, 2);
  }, [parsedPrettyPayload, selectedEvent]);

  const markdownAvailable = selectedEvent ? isLikelyMarkdown(selectedEvent.contentPreview) : false;

  useEffect(() => {
    if (!selectedEvent) {
      return;
    }

    if (payloadMode === 'markdown' && !markdownAvailable) {
      setPayloadMode('pretty');
    }
  }, [markdownAvailable, payloadMode, selectedEvent, setPayloadMode]);

  if (!selectedEvent) {
    return (
      <section className="run-agent-inspector-pane run-agent-inspector-pane--detail" aria-label="Agent stream inspector detail">
        <p>Select an event from the list to inspect payload details.</p>
      </section>
    );
  }

  const payloadIsTruncated = selectedEvent.contentPreview.length < selectedEvent.contentChars;

  const handleCopyPayload = async (): Promise<void> => {
    const copied = await copyTextToClipboard(selectedEvent.contentPreview);
    setUtilityFeedback(copied ? 'Payload copied.' : 'Unable to copy payload in this environment.');
  };

  const handleCopyMetadata = async (): Promise<void> => {
    const metadataText = selectedEvent.metadata ? JSON.stringify(selectedEvent.metadata, null, 2) : '{}';
    const copied = await copyTextToClipboard(metadataText);
    setUtilityFeedback(copied ? 'Metadata copied.' : 'Unable to copy metadata in this environment.');
  };

  const detailCodeClassName = wrapPayloadLines
    ? 'code-preview run-agent-inspector-payload'
    : 'code-preview run-agent-inspector-payload run-agent-inspector-payload--nowrap';

  return (
    <section className="run-agent-inspector-pane run-agent-inspector-pane--detail" aria-label="Agent stream inspector detail">
      <p className="meta-text">
        {`Selected event #${selectedEvent.sequence} · ${selectedEvent.type} · ${formatStreamTimestamp(selectedEvent.timestamp)}`}
      </p>
      <p className="meta-text">
        {payloadIsTruncated
          ? `Stored payload preview is truncated (${selectedEvent.contentPreview.length}/${selectedEvent.contentChars} chars).`
          : `Payload length: ${selectedEvent.contentChars} chars.`}
      </p>
      {selectedEvent.usage ? (
        <p className="meta-text">
          {`Usage Δ ${selectedEvent.usage.deltaTokens ?? 'n/a'} · cumulative ${selectedEvent.usage.cumulativeTokens ?? 'n/a'}`}
        </p>
      ) : null}

      <div className="action-row run-agent-inspector-mode-row" role="tablist" aria-label="Payload rendering mode">
        <button
          type="button"
          className={`button-link${payloadMode === 'pretty' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={payloadMode === 'pretty'}
          onClick={() => setPayloadMode('pretty')}
        >
          Pretty JSON
        </button>
        <button
          type="button"
          className={`button-link${payloadMode === 'raw' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={payloadMode === 'raw'}
          onClick={() => setPayloadMode('raw')}
        >
          Raw
        </button>
        <button
          type="button"
          className={`button-link${payloadMode === 'markdown' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={payloadMode === 'markdown'}
          onClick={() => setPayloadMode('markdown')}
          disabled={!markdownAvailable}
        >
          Rendered Markdown
        </button>
      </div>

      <div className="action-row run-agent-inspector-actions">
        <ActionButton onClick={() => setWrapPayloadLines(current => !current)}>
          {wrapPayloadLines ? 'Disable line wrap' : 'Enable line wrap'}
        </ActionButton>
        <ActionButton onClick={() => void handleCopyPayload()}>Copy payload</ActionButton>
        <ActionButton onClick={() => void handleCopyMetadata()} disabled={metadataRows.length === 0}>Copy metadata</ActionButton>
        <ActionButton onClick={() => downloadEventPayload(selectedEvent)}>Download payload (.json)</ActionButton>
      </div>

      {utilityFeedback ? <p className="meta-text">{utilityFeedback}</p> : null}

      {payloadMode === 'pretty' ? (
        prettyPayloadText ? (
          <pre className={detailCodeClassName}>
            <code dangerouslySetInnerHTML={{ __html: highlightJsonCode(prettyPayloadText) }} />
          </pre>
        ) : (
          <>
            <p className="meta-text">Payload is not valid JSON; displaying raw payload.</p>
            <pre className={detailCodeClassName}>
              <code>{selectedEvent.contentPreview}</code>
            </pre>
          </>
        )
      ) : null}

      {payloadMode === 'raw' ? (
        <pre className={detailCodeClassName}>
          <code>{selectedEvent.contentPreview}</code>
        </pre>
      ) : null}

      {payloadMode === 'markdown' ? (
        markdownAvailable ? (
          <div className="run-agent-inspector-markdown">{renderMarkdownPayload(selectedEvent.contentPreview)}</div>
        ) : (
          <p className="meta-text">Rendered Markdown is available only for markdown-like payloads.</p>
        )
      ) : null}

      <details>
        <summary>metadata</summary>
        {metadataRows.length === 0 ? (
          <p className="meta-text">No metadata captured for this event.</p>
        ) : (
          <dl className="run-agent-inspector-metadata-list">
            {metadataRows.map(([key, value]) => (
              <div key={key} className="run-agent-inspector-metadata-row">
                <dt>{key}</dt>
                <dd>
                  <pre className="code-preview run-agent-inspector-metadata-value">{value}</pre>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    </section>
  );
}

function SelectedStreamContent(props: Readonly<{
  selectedStreamNode: DashboardRunDetail['nodes'][number];
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
  selectedEventSequence: number | null;
  onSelectedEventSequenceChange: (sequence: number | null) => void;
  onToggleAutoScroll: () => void;
}>) {
  const {
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
    selectedEventSequence,
    onSelectedEventSequenceChange,
    onToggleAutoScroll,
  } = props;

  const [eventTypeFilter, setEventTypeFilter] = useState<StreamEventFilter>('all');
  const [eventSearchQuery, setEventSearchQuery] = useState<string>('');
  const [visibleEventCount, setVisibleEventCount] = useState<number>(STREAM_EVENT_WINDOW_SIZE);
  const [payloadMode, setPayloadMode] = useState<InspectorPayloadMode>('pretty');
  const [wrapPayloadLines, setWrapPayloadLines] = useState<boolean>(true);
  const [utilityFeedback, setUtilityFeedback] = useState<string | null>(null);

  useEffect(() => {
    setEventTypeFilter('all');
    setEventSearchQuery('');
    setVisibleEventCount(STREAM_EVENT_WINDOW_SIZE);
    setPayloadMode('pretty');
    setWrapPayloadLines(true);
    setUtilityFeedback(null);
  }, [selectedStreamNode.id, selectedStreamNode.attempt]);

  useEffect(() => {
    setVisibleEventCount(STREAM_EVENT_WINDOW_SIZE);
  }, [eventSearchQuery, eventTypeFilter]);

  const filteredEvents = useMemo(
    () => streamEvents.filter(event => eventMatchesInspectorFilter(event, eventTypeFilter, eventSearchQuery)),
    [eventSearchQuery, eventTypeFilter, streamEvents],
  );

  const selectedEvent = useMemo(
    () =>
      selectedEventSequence === null
        ? null
        : filteredEvents.find(event => event.sequence === selectedEventSequence) ?? null,
    [filteredEvents, selectedEventSequence],
  );

  return (
    <>
      <output className={`run-realtime-status run-realtime-status--${streamConnectionState}`} aria-live="polite">
        <span className="run-realtime-status__badge">{agentStreamLabel.badgeLabel}</span>
        <span className="meta-text">{agentStreamLabel.detail}</span>
        <span className="meta-text">
          {`Node ${selectedStreamNode.nodeKey} (attempt ${selectedStreamNode.attempt}) · last update ${formatLastUpdated(streamLastUpdatedAtMs, hasHydrated)}.`}
        </span>
      </output>

      {streamError && (streamConnectionState === 'reconnecting' || streamConnectionState === 'stale') ? (
        <output className="run-realtime-warning" aria-live="polite">
          {`Agent stream degraded: ${streamError}`}
        </output>
      ) : null}

      <div className="run-agent-inspector" role="region" aria-label="Agent output inspector">
        <EventListPane
          key={`${selectedStreamNode.id}:${selectedStreamNode.attempt}`}
          streamEvents={streamEvents}
          streamEventListRef={streamEventListRef}
          selectedEventSequence={selectedEventSequence}
          onSelectedEventSequenceChange={onSelectedEventSequenceChange}
          streamConnectionState={streamConnectionState}
          eventTypeFilter={eventTypeFilter}
          setEventTypeFilter={setEventTypeFilter}
          eventSearchQuery={eventSearchQuery}
          setEventSearchQuery={setEventSearchQuery}
          visibleEventCount={visibleEventCount}
          setVisibleEventCount={setVisibleEventCount}
          streamAutoScroll={streamAutoScroll}
          streamBufferedEvents={streamBufferedEvents}
          onToggleAutoScroll={onToggleAutoScroll}
        />

        <DetailPane
          selectedEvent={selectedEvent}
          payloadMode={payloadMode}
          setPayloadMode={setPayloadMode}
          wrapPayloadLines={wrapPayloadLines}
          setWrapPayloadLines={setWrapPayloadLines}
          utilityFeedback={utilityFeedback}
          setUtilityFeedback={setUtilityFeedback}
        />
      </div>
    </>
  );
}

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
  selectedEventSequence,
  onSelectedEventSequenceChange,
  setStreamAutoScroll,
  setStreamBufferedEvents,
  setStreamEvents,
}: RunAgentStreamCardProps) {
  const streamContent = selectedStreamNode ? (
    <SelectedStreamContent
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
      selectedEventSequence={selectedEventSequence}
      onSelectedEventSequenceChange={onSelectedEventSequenceChange}
      onToggleAutoScroll={() => {
        toggleStreamAutoScroll({
          streamAutoScroll,
          streamBufferedEvents,
          setStreamAutoScroll,
          setStreamBufferedEvents,
          setStreamEvents,
        });
      }}
    />
  ) : (
    <p>Select a node from Node Status to open its agent stream.</p>
  );

  if (!isTerminalRun) {
    return (
      <Card title="Agent stream" description="Agent output inspector for a selected node attempt.">
        {streamContent}
      </Card>
    );
  }

  const terminalStreamSummary = formatTerminalStreamSummary({
    selectedStreamNode,
    streamBufferedEvents,
    streamEvents,
  });

  return (
    <Card title="Agent stream" description="Agent output inspector for a selected node attempt.">
      <details className="run-agent-stream-collapsed">
        <summary className="run-agent-stream-collapsed__summary">{terminalStreamSummary}</summary>
        {streamContent}
      </details>
    </Card>
  );
}
