'use client';

import { taskWorkItemStatuses, type TaskWorkItemStatus, type WorkItemStatus, type WorkItemType } from '@alphred/shared';
import type { DragEndEvent, DragStartEvent, UniqueIdentifier } from '@dnd-kit/core';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  rectIntersection,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import { ActionButton } from '../../../ui/primitives';

type WorkItemActor = Readonly<{
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
}>;

type BoardConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stale';

type BoardEventSnapshot = Readonly<{
  id: number;
  repositoryId: number;
  workItemId: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}>;

type ApiErrorEnvelope = Readonly<{
  error?: {
    code?: string;
    message?: string;
  };
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    isRecord(payload) &&
    'error' in payload &&
    isRecord((payload as ApiErrorEnvelope).error) &&
    typeof (payload as ApiErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ApiErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

function toWorkItemsById(workItems: readonly DashboardWorkItemSnapshot[]): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  const entries: Record<number, DashboardWorkItemSnapshot> = {};
  for (const item of workItems) {
    entries[item.id] = item;
  }
  return entries;
}

function buildParentChain(
  workItem: DashboardWorkItemSnapshot,
  workItemsById: Readonly<Record<number, DashboardWorkItemSnapshot>>,
): DashboardWorkItemSnapshot[] {
  const chain: DashboardWorkItemSnapshot[] = [];
  const visited = new Set<number>();
  let parentId = workItem.parentId;
  while (parentId !== null) {
    if (visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    const parent = workItemsById[parentId];
    if (!parent) {
      break;
    }
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain.reverse();
}

function isTaskStatus(value: string): value is TaskWorkItemStatus {
  return (taskWorkItemStatuses as readonly string[]).includes(value);
}

function formatTaskStatusLabel(status: TaskWorkItemStatus): string {
  switch (status) {
    case 'InProgress':
      return 'In progress';
    case 'InReview':
      return 'In review';
    default:
      return status;
  }
}

type DragWorkItemData = Readonly<{
  workItemId: number;
  fromStatus: TaskWorkItemStatus;
}>;

function isDragWorkItemData(value: unknown): value is DragWorkItemData {
  return (
    isRecord(value) &&
    typeof value.workItemId === 'number' &&
    typeof value.fromStatus === 'string' &&
    isTaskStatus(value.fromStatus)
  );
}

function coerceNullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return fallback;
}

function coerceNullableStringArray(value: unknown, fallback: string[] | null): string[] | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value as string[];
  }
  return fallback;
}

function coerceNullableNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  return fallback;
}

function applyCreatedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.type !== 'string' || typeof payload.status !== 'string' || typeof payload.title !== 'string') {
    return previous;
  }

  const next: DashboardWorkItemSnapshot = {
    id: event.workItemId,
    repositoryId: event.repositoryId,
    type: payload.type as WorkItemType,
    status: payload.status as WorkItemStatus,
    title: payload.title,
    description: null,
    parentId: typeof payload.parentId === 'number' ? payload.parentId : null,
    tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : null,
    plannedFiles: Array.isArray(payload.plannedFiles) ? (payload.plannedFiles as string[]) : null,
    assignees: Array.isArray(payload.assignees) ? (payload.assignees as string[]) : null,
    priority: typeof payload.priority === 'number' ? payload.priority : null,
    estimate: typeof payload.estimate === 'number' ? payload.estimate : null,
    revision: typeof payload.revision === 'number' ? payload.revision : 0,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };

  return {
    ...previous,
    [event.workItemId]: existing ? { ...existing, ...next } : next,
  };
}

function applyUpdatedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.changes)) {
    return previous;
  }

  const changes = payload.changes;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    title: typeof changes.title === 'string' ? changes.title : existing.title,
    description: coerceNullableString(changes.description, existing.description),
    tags: coerceNullableStringArray(changes.tags, existing.tags),
    plannedFiles: coerceNullableStringArray(changes.plannedFiles, existing.plannedFiles),
    assignees: coerceNullableStringArray(changes.assignees, existing.assignees),
    priority: coerceNullableNumber(changes.priority, existing.priority),
    estimate: coerceNullableNumber(changes.estimate, existing.estimate),
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
  };

  return {
    ...previous,
    [existing.id]: next,
  };
}

function applyReparentedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload)) {
    return previous;
  }

  const parentIdValue = payload.toParentId;
  const parentId = typeof parentIdValue === 'number' ? parentIdValue : null;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    parentId,
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
  };

  return { ...previous, [existing.id]: next };
}

function applyStatusChangedBoardEvent(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  event: BoardEventSnapshot,
  existing: DashboardWorkItemSnapshot | undefined,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (!existing) {
    return previous;
  }

  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.toStatus !== 'string') {
    return previous;
  }

  const nextStatus = payload.toStatus;
  const next: DashboardWorkItemSnapshot = {
    ...existing,
    status: nextStatus as WorkItemStatus,
    revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
    updatedAt: event.createdAt,
  };

  return { ...previous, [existing.id]: next };
}

function applyBoardEventToWorkItems(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  repository: DashboardRepositoryState,
  event: BoardEventSnapshot,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (event.repositoryId !== repository.id) {
    return previous;
  }

  const existing = previous[event.workItemId];
  if (event.eventType === 'created') {
    return applyCreatedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'updated') {
    return applyUpdatedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'reparented') {
    return applyReparentedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'status_changed') {
    return applyStatusChangedBoardEvent(previous, event, existing);
  }

  if (event.eventType === 'breakdown_proposed' || event.eventType === 'breakdown_approved') {
    return applyStatusChangedBoardEvent(previous, event, existing);
  }

  return previous;
}

async function fetchWorkItem(params: {
  repositoryId: number;
  workItemId: number;
}): Promise<DashboardWorkItemSnapshot> {
  const response = await fetch(
    `/api/dashboard/work-items/${params.workItemId}?repositoryId=${params.repositoryId}`,
    { method: 'GET' },
  );

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh work item'));
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    throw new Error('Unable to refresh work item (malformed response).');
  }

  return payload.workItem as DashboardWorkItemSnapshot;
}

async function moveWorkItemStatus(params: {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  toStatus: TaskWorkItemStatus;
  actor: WorkItemActor;
}): Promise<{ ok: true; workItem: DashboardWorkItemSnapshot } | { ok: false; status: number; message: string }> {
  const response = await fetch(`/api/dashboard/work-items/${params.workItemId}/actions/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
      expectedRevision: params.expectedRevision,
      toStatus: params.toStatus,
      actorType: params.actor.actorType,
      actorLabel: params.actor.actorLabel,
    }),
  });

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, 'Unable to move work item'),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    return {
      ok: false,
      status: 500,
      message: 'Unable to move work item (malformed response).',
    };
  }

  return { ok: true, workItem: payload.workItem as DashboardWorkItemSnapshot };
}

function buildBoardEventsSseUrl(repositoryId: number, lastEventId: number): string {
  const params = new URLSearchParams();
  params.set('transport', 'sse');
  params.set('lastEventId', String(lastEventId));
  return `/api/dashboard/repositories/${repositoryId}/board/events?${params.toString()}`;
}

function parseBoardEvent(rawEvent: Event): BoardEventSnapshot | null {
  if (!('data' in rawEvent)) {
    return null;
  }

  const message = rawEvent as MessageEvent;
  const payload = typeof message.data === 'string' ? parseJsonSafely(message.data) : message.data;
  if (!isRecord(payload)) {
    return null;
  }

  if (
    typeof payload.id !== 'number' ||
    typeof payload.repositoryId !== 'number' ||
    typeof payload.workItemId !== 'number' ||
    typeof payload.eventType !== 'string' ||
    typeof payload.createdAt !== 'string'
  ) {
    return null;
  }

  return {
    id: payload.id,
    repositoryId: payload.repositoryId,
    workItemId: payload.workItemId,
    eventType: payload.eventType,
    payload: payload.payload ?? null,
    createdAt: payload.createdAt,
  };
}

function renderStringList(items: string[] | null): ReactNode {
  if (!items || items.length === 0) {
    return <span className="meta-text">None</span>;
  }

  return (
    <ul className="board-string-list">
      {items.map(entry => (
        <li key={entry}>
          <code>{entry}</code>
        </li>
      ))}
    </ul>
  );
}

type BoardTaskCardProps = Readonly<{
  task: DashboardWorkItemSnapshot;
  selected: boolean;
  moving: boolean;
  onSelect: (workItemId: number) => void;
}>;

function BoardTaskCard({ task, selected, moving, onSelect }: BoardTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: {
      workItemId: task.id,
      fromStatus: task.status as TaskWorkItemStatus,
    } satisfies DragWorkItemData,
    disabled: moving,
  });

  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`board-card-shell${isDragging ? ' board-card-shell--dragging' : ''}`}
      data-dragging={isDragging ? 'true' : 'false'}
    >
      <button
        {...attributes}
        {...listeners}
        className={`board-card ${selected ? 'board-card--selected' : ''}`}
        data-selected={selected ? 'true' : 'false'}
        type="button"
        onClick={() => onSelect(task.id)}
        aria-pressed={selected}
        aria-disabled={moving || undefined}
        disabled={moving}
      >
        <span className="board-card__title">{task.title}</span>
        <span className="board-card__id meta-text">#{task.id}</span>
      </button>
    </li>
  );
}

type BoardColumnProps = Readonly<{
  status: TaskWorkItemStatus;
  tasks: readonly DashboardWorkItemSnapshot[];
  selectedWorkItemId: number | null;
  movingWorkItemIds: ReadonlySet<number>;
  onSelectWorkItem: (workItemId: number) => void;
}>;

function BoardColumn({ status, tasks, selectedWorkItemId, movingWorkItemIds, onSelectWorkItem }: BoardColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: status,
  });
  const { active } = useDndContext();

  const activeData = active?.data.current;
  const isValidDrag = isDragWorkItemData(activeData);
  const isFromSameColumn = isValidDrag && activeData.fromStatus === status;

  return (
    <section
      ref={setNodeRef}
      className={`board-column${isOver ? ' board-column--over' : ''}${isFromSameColumn ? ' board-column--same' : ''}`}
      aria-label={`Tasks ${status}`}
      data-status={status}
      data-over={isOver ? 'true' : 'false'}
    >
      <header className="board-column__header">
        <h4 className="board-column__title">{formatTaskStatusLabel(status)}</h4>
        <span className="board-column__count meta-text" aria-label={`${tasks.length} tasks`}>
          {tasks.length}
        </span>
      </header>
      {tasks.length === 0 ? (
        <p className="meta-text board-column__empty" data-over={isOver ? 'true' : 'false'}>
          {isValidDrag && isOver ? 'Drop to move here.' : 'No tasks.'}
        </p>
      ) : (
        <ul className="board-column__list" aria-label={`${status} tasks`}>
          {tasks.map(task => (
            <BoardTaskCard
              key={task.id}
              task={task}
              selected={selectedWorkItemId === task.id}
              moving={movingWorkItemIds.has(task.id)}
              onSelect={onSelectWorkItem}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export type RepositoryBoardPageContentProps = Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  initialLatestEventId: number;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
}>;

export function RepositoryBoardPageContent({
  repository,
  actor,
  initialLatestEventId,
  initialWorkItems,
}: RepositoryBoardPageContentProps) {
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(
    () => toWorkItemsById(initialWorkItems),
  );
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<BoardConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [movingWorkItemIds, setMovingWorkItemIds] = useState<ReadonlySet<number>>(() => new Set());
  const [activeDragWorkItemId, setActiveDragWorkItemId] = useState<number | null>(null);

  const lastEventIdRef = useRef<number>(initialLatestEventId);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskWorkItemStatus, DashboardWorkItemSnapshot[]> = {
      Draft: [],
      Ready: [],
      InProgress: [],
      Blocked: [],
      InReview: [],
      Done: [],
    };

    for (const item of Object.values(workItemsById)) {
      if (item.type !== 'task') {
        continue;
      }
      if (!isTaskStatus(item.status)) {
        continue;
      }
      grouped[item.status].push(item);
    }

    for (const status of taskWorkItemStatuses) {
      grouped[status].sort((a, b) => a.id - b.id);
    }

    return grouped;
  }, [workItemsById]);

  const selectedWorkItem = selectedWorkItemId === null ? null : (workItemsById[selectedWorkItemId] ?? null);
  const selectedParentChain = useMemo(() => {
    if (!selectedWorkItem) {
      return [];
    }
    return buildParentChain(selectedWorkItem, workItemsById);
  }, [selectedWorkItem, workItemsById]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnectionState('stale');
      setConnectionError('Board live updates are unavailable in this environment.');
      return () => undefined;
    }

    let disposed = false;
    let reconnectTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let source: EventSource | null = null;
    let reconnectFailures = 0;

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

    const handleReconnect = (): void => {
      if (disposed) {
        return;
      }

      reconnectFailures += 1;
      const retryDelayMs = Math.min(1_000 * 2 ** Math.max(0, reconnectFailures - 1), 15_000);
      setConnectionState('reconnecting');
      clearReconnectTimer();
      reconnectTimeoutId = globalThis.setTimeout(() => {
        void connect();
      }, retryDelayMs);
    };

    const handleBoardState = (rawEvent: Event): void => {
      const payload = parseJsonSafely((rawEvent as MessageEvent).data);
      if (!isRecord(payload) || payload.connectionState !== 'live') {
        return;
      }
      setConnectionState('live');
    };

    const handleBoardEvent = (rawEvent: Event): void => {
      const parsed = parseBoardEvent(rawEvent);
      if (!parsed) {
        setConnectionError('Board event payload was malformed.');
        return;
      }

      lastEventIdRef.current = Math.max(lastEventIdRef.current, parsed.id);
      setWorkItemsById(previous => applyBoardEventToWorkItems(previous, repository, parsed));
    };

    const handleBoardError = (rawEvent: Event): void => {
      const payload = parseJsonSafely((rawEvent as MessageEvent).data);
      if (isRecord(payload) && typeof payload.message === 'string') {
        setConnectionError(payload.message);
        return;
      }
      setConnectionError('Board stream channel reported an error.');
    };

    const connect = async (): Promise<void> => {
      if (disposed) {
        return;
      }

      closeSource();
      setConnectionState('connecting');
      setConnectionError(null);

      source = new EventSource(buildBoardEventsSseUrl(repository.id, lastEventIdRef.current));

      source.onopen = () => {
        if (disposed) return;
        reconnectFailures = 0;
        setConnectionState('live');
        setConnectionError(null);
      };

      source.addEventListener('board_state', handleBoardState);
      source.addEventListener('board_event', handleBoardEvent);
      source.addEventListener('board_error', handleBoardError);

      source.onerror = () => {
        closeSource();
        if (disposed) return;
        setConnectionError('Board stream connection dropped.');
        handleReconnect();
      };
    };

    void connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      closeSource();
    };
  }, [repository]);

  useEffect(() => {
    if (selectedWorkItemId === null) {
      return () => undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSelectedWorkItemId(null);
      }
    };

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedWorkItemId]);

  const handleMove = async (workItemId: number, nextStatusRaw: string) => {
    const current = workItemsById[workItemId];
    if (current?.type !== 'task') {
      return;
    }

    if (!isTaskStatus(nextStatusRaw)) {
      setActionMessage({ tone: 'error', message: 'Invalid target status.' });
      return;
    }

    const nextStatus = nextStatusRaw;
    if (current.status === nextStatus) {
      return;
    }

    setActionMessage(null);
    setMovingWorkItemIds(previous => new Set([...previous, workItemId]));

    try {
      const moveResult = await moveWorkItemStatus({
        repositoryId: repository.id,
        workItemId,
        expectedRevision: current.revision,
        toStatus: nextStatus,
        actor,
      });

      if (moveResult.ok) {
        setWorkItemsById(previous => ({
          ...previous,
          [workItemId]: moveResult.workItem,
        }));
        setActionMessage({ tone: 'success', message: `Moved "${current.title}" to ${nextStatus}.` });
        return;
      }

      if (moveResult.status === 409) {
        const refreshed = await fetchWorkItem({ repositoryId: repository.id, workItemId });
        setWorkItemsById(previous => ({
          ...previous,
          [workItemId]: refreshed,
        }));
        setActionMessage({ tone: 'error', message: `${moveResult.message} Refreshed from server.` });
        return;
      }

      setActionMessage({ tone: 'error', message: moveResult.message });
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to move work item.',
      });
    } finally {
      setMovingWorkItemIds(previous => {
        const next = new Set(previous);
        next.delete(workItemId);
        return next;
      });
    }
  };

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id;
    const workItemId = typeof id === 'number' ? id : Number(id);
    if (!Number.isFinite(workItemId)) {
      setActiveDragWorkItemId(null);
      return;
    }
    setActiveDragWorkItemId(workItemId);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragWorkItemId(null);

    const activeId: UniqueIdentifier = event.active.id;
    const workItemId = typeof activeId === 'number' ? activeId : Number(activeId);
    if (!Number.isFinite(workItemId)) {
      return;
    }

    const overId = event.over?.id;
    if (typeof overId !== 'string') {
      return;
    }

    if (movingWorkItemIds.has(workItemId)) {
      return;
    }

    await handleMove(workItemId, overId);
  };

  const renderConnectionLabel = (): ReactNode => {
    const labelByState: Readonly<Record<BoardConnectionState, string>> = {
      live: 'Live',
      connecting: 'Connecting',
      reconnecting: 'Reconnecting',
      stale: 'Stale',
    };
    const label = labelByState[connectionState];
    return (
      <div className="board-connection" aria-label={`Connection status: ${label}`}>
        <span className={`board-connection__dot board-connection__dot--${connectionState}`} aria-hidden="true" />
        <span className="meta-text">{label}</span>
      </div>
    );
  };

  const renderBanner = (): ReactNode => {
    if (!actionMessage) {
      return null;
    }

    const className = `repo-banner repo-banner--${actionMessage.tone}`;
    if (actionMessage.tone === 'error') {
      return (
        <p className={className} role="alert">
          {actionMessage.message}
        </p>
      );
    }

    return (
      <output className={className} aria-live="polite">
        {actionMessage.message}
      </output>
    );
  };

  const clearSelection = () => setSelectedWorkItemId(null);

  const renderDetails = (): ReactNode => {
    if (!selectedWorkItem) {
      return null;
    }

    const status =
      selectedWorkItem.type === 'task' && isTaskStatus(selectedWorkItem.status)
        ? selectedWorkItem.status
        : null;
    const moving = movingWorkItemIds.has(selectedWorkItem.id);
    const dialogTitleId = `board-detail-dialog-title-${selectedWorkItem.id}`;
    const statusSelectId = `board-detail-status-${selectedWorkItem.id}`;

    return (
      <div className="board-drawer-scrim">
        <button
          type="button"
          className="board-drawer-scrim__backdrop"
          onClick={clearSelection}
          aria-label="Close task details"
          title="Close"
        />
        <dialog className="board-drawer" open aria-modal="true" aria-labelledby={dialogTitleId} aria-busy={moving || undefined}>
          <header className="board-drawer__header">
            <span className="board-drawer__kicker meta-text">Task</span>
            <ActionButton
              tone="secondary"
              className="board-drawer__close"
              onClick={clearSelection}
              aria-label="Close task details"
              title="Close"
            >
              ×
            </ActionButton>
          </header>

          <div className="board-drawer__summary">
            <h3 className="board-drawer__title" id={dialogTitleId}>
              {selectedWorkItem.title}
            </h3>

            <div className="board-drawer__meta" aria-label="Task metadata">
              <span className="board-pill">#{selectedWorkItem.id}</span>
              <span className="board-pill">{selectedWorkItem.type}</span>
            </div>
          </div>

          {status ? (
            <div className="board-drawer__control">
              <label htmlFor={statusSelectId} className="meta-text">
                Status
              </label>
              <select
                id={statusSelectId}
                value={status}
                onChange={(event) => {
                  void handleMove(selectedWorkItem.id, event.target.value);
                }}
                disabled={moving}
                aria-disabled={moving}
                className="board-drawer__select"
              >
                {taskWorkItemStatuses.map(entry => (
                  <option key={entry} value={entry}>
                    {formatTaskStatusLabel(entry)}
                  </option>
                ))}
              </select>
              {moving ? (
                <output className="meta-text board-drawer__moving" aria-live="polite">
                  Moving…
                </output>
              ) : null}
            </div>
          ) : null}

          <div className="board-detail__section board-detail__section--divider">
            <h5>Parent chain</h5>
            {selectedParentChain.length === 0 ? (
              <p className="meta-text">None</p>
            ) : (
              <ol className="board-parent-chain">
                {selectedParentChain.map(parent => (
                  <li key={parent.id}>
                    <span className="board-pill">{parent.type}</span>
                    <span>
                      {parent.type === 'story' ? (
                        <Link href={`/repositories/${repository.id}/stories/${parent.id}`}>{parent.title}</Link>
                      ) : (
                        parent.title
                      )}{' '}
                      <span className="meta-text">#{parent.id}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Planned files</h5>
            {renderStringList(selectedWorkItem.plannedFiles)}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Assignees</h5>
            {renderStringList(selectedWorkItem.assignees)}
          </div>
        </dialog>
      </div>
    );
  };

  return (
    <div className="page-stack">
      <div className="board-page-header">
        <div>
          <h2 className="board-page-title">{repository.name} board</h2>
          <p className="meta-text">Repo-scoped tasks grouped by status with realtime updates. Drag cards between columns to move them.</p>
        </div>
        <div className="board-page-header__status">
          {renderConnectionLabel()}
        </div>
      </div>

      {connectionError ? (
        <p className="repo-banner repo-banner--error" role="alert">
          {connectionError}
        </p>
      ) : null}
      {renderBanner()}

      <section className="board-kanban" aria-label="Task board">
        <DndContext
          sensors={sensors}
          collisionDetection={rectIntersection}
          onDragStart={handleDragStart}
          onDragEnd={(event) => {
            void handleDragEnd(event);
          }}
        >
          <div className="board-columns-shell" aria-label="Board columns">
            <div className="board-columns">
              {taskWorkItemStatuses.map(status => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={tasksByStatus[status]}
                  selectedWorkItemId={selectedWorkItemId}
                  movingWorkItemIds={movingWorkItemIds}
                  onSelectWorkItem={(workItemId) => setSelectedWorkItemId(workItemId)}
                />
              ))}
            </div>
          </div>
          <DragOverlay>
            {activeDragWorkItemId !== null && workItemsById[activeDragWorkItemId] ? (
              <div className="board-card board-card--overlay" aria-hidden="true">
                <span className="board-card__title">{workItemsById[activeDragWorkItemId]!.title}</span>
                <span className="board-card__id meta-text">#{activeDragWorkItemId}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {renderDetails()}
      </section>
    </div>
  );
}
