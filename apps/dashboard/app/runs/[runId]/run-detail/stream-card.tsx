import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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

type ParsedJsonPayload =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false }>;

function parseJsonPayload(payload: string): ParsedJsonPayload {
  try {
    return { ok: true, value: JSON.parse(payload) };
  } catch {
    return { ok: false };
  }
}

function createRepeatedContentKeyFactory(prefix: string): (value: string) => string {
  const occurrences = new Map<string, number>();

  return (value: string): string => {
    const seenCount = occurrences.get(value) ?? 0;
    occurrences.set(value, seenCount + 1);
    return seenCount === 0 ? `${prefix}-${value}` : `${prefix}-${value}-${seenCount}`;
  };
}

function startsWithMarkdownHeading(line: string): boolean {
  const trimmedLine = line.trimStart();
  let headingDepth = 0;
  while (headingDepth < trimmedLine.length && headingDepth < 6 && trimmedLine[headingDepth] === '#') {
    headingDepth += 1;
  }

  if (headingDepth === 0 || headingDepth >= trimmedLine.length) {
    return false;
  }

  return trimmedLine[headingDepth] === ' ';
}

function startsWithOrderedListPrefix(line: string): boolean {
  const trimmedLine = line.trimStart();
  let index = 0;

  while (index < trimmedLine.length && trimmedLine[index] >= '0' && trimmedLine[index] <= '9') {
    index += 1;
  }

  if (index === 0 || index + 1 >= trimmedLine.length) {
    return false;
  }

  return trimmedLine[index] === '.' && trimmedLine[index + 1] === ' ';
}

function hasMarkdownLink(line: string): boolean {
  const openBracketIndex = line.indexOf('[');
  const closeBracketIndex = line.indexOf(']', openBracketIndex + 1);
  const openParenIndex = line.indexOf('(', closeBracketIndex + 1);
  const closeParenIndex = line.indexOf(')', openParenIndex + 1);

  return openBracketIndex !== -1 && closeBracketIndex !== -1 && openParenIndex !== -1 && closeParenIndex !== -1;
}

function parseMarkdownHeading(line: string): Readonly<{ depth: number; text: string }> | null {
  const trimmedLine = line.trimStart();
  let depth = 0;

  while (depth < trimmedLine.length && depth < 6 && trimmedLine[depth] === '#') {
    depth += 1;
  }

  if (depth === 0 || depth >= trimmedLine.length || trimmedLine[depth] !== ' ') {
    return null;
  }

  const text = trimmedLine.slice(depth + 1).trim();
  if (text.length === 0) {
    return null;
  }

  return { depth, text };
}

function isLikelyMarkdown(value: string): boolean {
  if (value.includes('```')) {
    return true;
  }

  const lines = value.split('\n');
  return lines.some((line) => {
    const trimmedLine = line.trimStart();
    return (
      startsWithMarkdownHeading(trimmedLine) ||
      trimmedLine.startsWith('- ') ||
      trimmedLine.startsWith('* ') ||
      startsWithOrderedListPrefix(trimmedLine) ||
      hasMarkdownLink(trimmedLine)
    );
  });
}

function renderMarkdownPayload(value: string): ReactNode {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return <p className="meta-text">Payload is empty.</p>;
  }

  const blocks = normalized.split(/\n{2,}/);
  const nextBlockKey = createRepeatedContentKeyFactory('md-block');

  const renderMarkdownLines = (lines: readonly string[], blockKey: string): ReactNode => {
    if (lines.length === 0) {
      return null;
    }

    const nextLineKey = createRepeatedContentKeyFactory(`${blockKey}-line`);

    if (lines.every(line => /^[-*]\s+/.test(line.trim()))) {
      return (
        <ul key={`${blockKey}-ul`} className="run-agent-inspector-markdown-list">
          {lines.map((line) => (
            <li key={nextLineKey(line)}>{line.replace(/^[-*]\s+/, '')}</li>
          ))}
        </ul>
      );
    }

    if (lines.every(line => /^\d+\.\s+/.test(line.trim()))) {
      return (
        <ol key={`${blockKey}-ol`} className="run-agent-inspector-markdown-list">
          {lines.map((line) => (
            <li key={nextLineKey(line)}>{line.replace(/^\d+\.\s+/, '')}</li>
          ))}
        </ol>
      );
    }

    return (
      <p key={`${blockKey}-paragraph`}>
        {lines.map((line, lineIndex) => (
          <span key={nextLineKey(line)}>
            {line}
            {lineIndex < lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  };

  return blocks.map((block) => {
    const blockKey = nextBlockKey(block);

    if (block.startsWith('```') && block.endsWith('```')) {
      const codeContent = block
        .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
        .replace(/\n?```$/, '');
      return (
        <pre key={`${blockKey}-code`} className="code-preview run-agent-inspector-markdown-code">
          <code>{codeContent}</code>
        </pre>
      );
    }

    const lines = block.split('\n');

    const heading = parseMarkdownHeading(lines[0] ?? '');
    if (heading) {
      const { depth: headingDepth, text } = heading;
      const headingElement = headingDepth <= 2 ? <h4>{text}</h4> : <h5>{text}</h5>;
      const trailingLines = lines.slice(1).filter(line => line.trim().length > 0);

      if (trailingLines.length === 0) {
        return headingDepth <= 2
          ? <h4 key={`${blockKey}-heading`}>{text}</h4>
          : <h5 key={`${blockKey}-heading`}>{text}</h5>;
      }

      return (
        <Fragment key={`${blockKey}-heading-block`}>
          {headingElement}
          {renderMarkdownLines(trailingLines, `${blockKey}-trailing`)}
        </Fragment>
      );
    }

    return renderMarkdownLines(lines, blockKey);
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
    payload: parsedPayload.ok ? parsedPayload.value : event.contentPreview,
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
  const previousLatestFilteredEventSequenceRef = useRef<number | null>(null);

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
      previousLatestFilteredEventSequenceRef.current = null;
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

    const latestEventSequence = filteredEvents.at(-1)?.sequence ?? null;
    const hasSelectedEvent =
      selectedEventSequence !== null && filteredEvents.some(event => event.sequence === selectedEventSequence);
    const shouldFollowLatestEvent = streamAutoScroll && streamConnectionState === 'live';
    if (shouldFollowLatestEvent) {
      const observedLatestEventSequence = previousLatestFilteredEventSequenceRef.current;
      const hasNewLatestEvent = observedLatestEventSequence !== null && observedLatestEventSequence !== latestEventSequence;
      const shouldSelectLatestEvent = selectedEventSequence === null || !hasSelectedEvent || hasNewLatestEvent;

      if (shouldSelectLatestEvent && selectedEventSequence !== latestEventSequence) {
        onSelectedEventSequenceChange(latestEventSequence);
      }
      previousLatestFilteredEventSequenceRef.current = latestEventSequence;
      return;
    }
    previousLatestFilteredEventSequenceRef.current = latestEventSequence;

    if (hasSelectedEvent) {
      return;
    }

    onSelectedEventSequenceChange(latestEventSequence);
  }, [filteredEvents, onSelectedEventSequenceChange, selectedEventSequence, streamAutoScroll, streamConnectionState]);

  useEffect(() => {
    if (selectedEventSequence === null) {
      return;
    }

    if (streamAutoScroll && streamConnectionState === 'live') {
      return;
    }

    const selectedIsVisible = visibleEvents.some(event => event.sequence === selectedEventSequence);
    if (selectedIsVisible) {
      return;
    }

    if (filteredEvents.some(event => event.sequence === selectedEventSequence)) {
      setVisibleEventCount(filteredEvents.length);
    }
  }, [
    filteredEvents,
    selectedEventSequence,
    setVisibleEventCount,
    streamAutoScroll,
    streamConnectionState,
    visibleEvents,
  ]);

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

  const resolveNextEventForKeyboardInput = (
    keyboardEvent: KeyboardEvent<HTMLButtonElement>,
    selectedSequence: number,
  ): DashboardRunNodeStreamEvent | null => {
    if (visibleEvents.length === 0) {
      return null;
    }

    const selectedIndex = visibleEvents.findIndex(event => event.sequence === selectedSequence);
    const clampedSelectedIndex = selectedIndex === -1 ? visibleEvents.length - 1 : selectedIndex;

    if (keyboardEvent.key === 'ArrowDown') {
      return visibleEvents[Math.min(clampedSelectedIndex + 1, visibleEvents.length - 1)] ?? null;
    }
    if (keyboardEvent.key === 'ArrowUp') {
      return visibleEvents[Math.max(clampedSelectedIndex - 1, 0)] ?? null;
    }
    if (keyboardEvent.key === 'Home') {
      return visibleEvents[0] ?? null;
    }
    if (keyboardEvent.key === 'End') {
      return visibleEvents.at(-1) ?? null;
    }

    return null;
  };

  const handleEventButtonKeyDown = (
    keyboardEvent: KeyboardEvent<HTMLButtonElement>,
    selectedSequence: number,
  ): void => {
    const nextEvent = resolveNextEventForKeyboardInput(keyboardEvent, selectedSequence);
    if (!nextEvent) {
      return;
    }

    keyboardEvent.preventDefault();
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
                  onKeyDown={(keyboardEvent) => {
                    handleEventButtonKeyDown(keyboardEvent, event.sequence);
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

function resolveDetailCodeClassName(wrapPayloadLines: boolean): string {
  return wrapPayloadLines
    ? 'code-preview run-agent-inspector-payload'
    : 'code-preview run-agent-inspector-payload run-agent-inspector-payload--nowrap';
}

function renderPayloadContent({
  payloadMode,
  prettyPayloadText,
  prettyPayloadValue,
  detailCodeClassName,
  contentPreview,
  markdownAvailable,
}: Readonly<{
  payloadMode: InspectorPayloadMode;
  prettyPayloadText: string | null;
  prettyPayloadValue: unknown;
  detailCodeClassName: string;
  contentPreview: string;
  markdownAvailable: boolean;
}>): ReactNode {
  if (payloadMode === 'pretty') {
    if (prettyPayloadText) {
      let prettyCodeContent: ReactNode = prettyPayloadText;
      if (prettyPayloadValue === null) {
        prettyCodeContent = <span className="run-agent-inspector-token--null">null</span>;
      } else if (typeof prettyPayloadValue === 'boolean') {
        prettyCodeContent = <span className="run-agent-inspector-token--boolean">{prettyPayloadText}</span>;
      } else if (typeof prettyPayloadValue === 'number') {
        prettyCodeContent = <span className="run-agent-inspector-token--number">{prettyPayloadText}</span>;
      } else if (typeof prettyPayloadValue === 'string') {
        prettyCodeContent = <span className="run-agent-inspector-token--string">{prettyPayloadText}</span>;
      }

      return (
        <pre className={detailCodeClassName}>
          <code>{prettyCodeContent}</code>
        </pre>
      );
    }

    return (
      <>
        <p className="meta-text">Payload is not valid JSON; displaying raw payload.</p>
        <pre className={detailCodeClassName}>
          <code>{contentPreview}</code>
        </pre>
      </>
    );
  }

  if (payloadMode === 'raw') {
    return (
      <pre className={detailCodeClassName}>
        <code>{contentPreview}</code>
      </pre>
    );
  }

  if (!markdownAvailable) {
    return <p className="meta-text">Rendered Markdown is available only for markdown-like payloads.</p>;
  }

  return <div className="run-agent-inspector-markdown">{renderMarkdownPayload(contentPreview)}</div>;
}

function renderMetadataContent(metadataRows: readonly (readonly [string, string])[]): ReactNode {
  if (metadataRows.length === 0) {
    return <p className="meta-text">No metadata captured for this event.</p>;
  }

  return (
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
    if (!selectedEvent || parsedPrettyPayload === null || !parsedPrettyPayload.ok) {
      return null;
    }

    return JSON.stringify(parsedPrettyPayload.value, null, 2);
  }, [parsedPrettyPayload, selectedEvent]);

  const markdownAvailable = selectedEvent ? isLikelyMarkdown(selectedEvent.contentPreview) : false;
  const prettyPayloadValue = parsedPrettyPayload?.ok ? parsedPrettyPayload.value : null;

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
  const payloadSummaryLabel = payloadIsTruncated
    ? `Stored payload preview is truncated (${selectedEvent.contentPreview.length}/${selectedEvent.contentChars} chars).`
    : `Payload length: ${selectedEvent.contentChars} chars.`;
  const usageSummaryLabel = selectedEvent.usage
    ? `Usage Δ ${selectedEvent.usage.deltaTokens ?? 'n/a'} · cumulative ${selectedEvent.usage.cumulativeTokens ?? 'n/a'}`
    : null;

  const handleCopyPayload = async (): Promise<void> => {
    const copied = await copyTextToClipboard(selectedEvent.contentPreview);
    setUtilityFeedback(copied ? 'Payload copied.' : 'Unable to copy payload in this environment.');
  };

  const handleCopyMetadata = async (): Promise<void> => {
    const metadataText = selectedEvent.metadata ? JSON.stringify(selectedEvent.metadata, null, 2) : '{}';
    const copied = await copyTextToClipboard(metadataText);
    setUtilityFeedback(copied ? 'Metadata copied.' : 'Unable to copy metadata in this environment.');
  };

  const detailCodeClassName = resolveDetailCodeClassName(wrapPayloadLines);
  const payloadContent = renderPayloadContent({
    payloadMode,
    prettyPayloadText,
    prettyPayloadValue,
    detailCodeClassName,
    contentPreview: selectedEvent.contentPreview,
    markdownAvailable,
  });

  return (
    <section className="run-agent-inspector-pane run-agent-inspector-pane--detail" aria-label="Agent stream inspector detail">
      <p className="meta-text">
        {`Selected event #${selectedEvent.sequence} · ${selectedEvent.type} · ${formatStreamTimestamp(selectedEvent.timestamp)}`}
      </p>
      <p className="meta-text">{payloadSummaryLabel}</p>
      {usageSummaryLabel ? <p className="meta-text">{usageSummaryLabel}</p> : null}

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
      {payloadContent}

      <details>
        <summary>metadata</summary>
        {renderMetadataContent(metadataRows)}
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
  const previousInspectorNodeKeyRef = useRef<string | null>(null);
  const previousSelectedEventSequenceRef = useRef<number | null>(selectedEventSequence);

  useEffect(() => {
    const nextInspectorNodeKey = `${selectedStreamNode.id}:${selectedStreamNode.attempt}`;
    const previousInspectorNodeKey = previousInspectorNodeKeyRef.current;
    const inspectorNodeChanged = previousInspectorNodeKey !== null && previousInspectorNodeKey !== nextInspectorNodeKey;
    if (inspectorNodeChanged && previousSelectedEventSequenceRef.current !== null) {
      onSelectedEventSequenceChange(null);
    }
    previousInspectorNodeKeyRef.current = nextInspectorNodeKey;

    setEventTypeFilter('all');
    setEventSearchQuery('');
    setVisibleEventCount(STREAM_EVENT_WINDOW_SIZE);
    setPayloadMode('pretty');
    setWrapPayloadLines(true);
    setUtilityFeedback(null);
  }, [onSelectedEventSequenceChange, selectedStreamNode.id, selectedStreamNode.attempt]);

  useEffect(() => {
    previousSelectedEventSequenceRef.current = selectedEventSequence;
  }, [selectedEventSequence]);

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

      <section className="run-agent-inspector" aria-label="Agent output inspector">
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
      </section>
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
