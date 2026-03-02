'use client';

import { taskWorkItemStatuses, type TaskWorkItemStatus, type WorkItemStatus, type WorkItemType } from '@alphred/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '../../../../src/server/dashboard-contracts';
import { ActionButton, Card, Panel } from '../../../ui/primitives';

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

function applyBoardEventToWorkItems(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  repository: DashboardRepositoryState,
  event: BoardEventSnapshot,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (event.repositoryId !== repository.id) {
    return previous;
  }

  const existing = previous[event.workItemId];
  const payload = event.payload;

  switch (event.eventType) {
    case 'created': {
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

    case 'updated': {
      if (!existing) {
        return previous;
      }
      if (!isRecord(payload) || !isRecord(payload.changes)) {
        return previous;
      }

      const changes = payload.changes as Record<string, unknown>;
      const next: DashboardWorkItemSnapshot = {
        ...existing,
        title: typeof changes.title === 'string' ? changes.title : existing.title,
        description:
          changes.description === null || typeof changes.description === 'string'
            ? (changes.description as string | null)
            : existing.description,
        tags: Array.isArray(changes.tags) ? (changes.tags as string[]) : changes.tags === null ? null : existing.tags,
        plannedFiles: Array.isArray(changes.plannedFiles) ? (changes.plannedFiles as string[]) : changes.plannedFiles === null ? null : existing.plannedFiles,
        assignees: Array.isArray(changes.assignees) ? (changes.assignees as string[]) : changes.assignees === null ? null : existing.assignees,
        priority: typeof changes.priority === 'number' ? changes.priority : changes.priority === null ? null : existing.priority,
        estimate: typeof changes.estimate === 'number' ? changes.estimate : changes.estimate === null ? null : existing.estimate,
        revision: typeof payload.revision === 'number' ? payload.revision : existing.revision,
        updatedAt: event.createdAt,
      };

      return {
        ...previous,
        [existing.id]: next,
      };
    }

    case 'reparented': {
      if (!existing) {
        return previous;
      }
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

    case 'status_changed': {
      if (!existing) {
        return previous;
      }
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

    default:
      return previous;
  }
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
    <ul className="entity-list board-string-list">
      {items.map(entry => (
        <li key={entry}>
          <code>{entry}</code>
        </li>
      ))}
    </ul>
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

  const selectedWorkItem = selectedWorkItemId !== null ? workItemsById[selectedWorkItemId] ?? null : null;
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

      source.addEventListener('board_state', (rawEvent: Event) => {
        const payload = parseJsonSafely((rawEvent as MessageEvent).data);
        if (!isRecord(payload) || payload.connectionState !== 'live') {
          return;
        }
        setConnectionState('live');
        if (typeof payload.latestEventId === 'number') {
          lastEventIdRef.current = Math.max(lastEventIdRef.current, payload.latestEventId);
        }
      });

      source.addEventListener('board_event', (rawEvent: Event) => {
        const parsed = parseBoardEvent(rawEvent);
        if (!parsed) {
          setConnectionError('Board event payload was malformed.');
          return;
        }

        lastEventIdRef.current = Math.max(lastEventIdRef.current, parsed.id);
        setWorkItemsById(previous => applyBoardEventToWorkItems(previous, repository, parsed));
      });

      source.addEventListener('board_error', (rawEvent: Event) => {
        const payload = parseJsonSafely((rawEvent as MessageEvent).data);
        if (isRecord(payload) && typeof payload.message === 'string') {
          setConnectionError(payload.message);
          return;
        }
        setConnectionError('Board stream channel reported an error.');
      });

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

  const handleMove = async (workItemId: number, nextStatusRaw: string) => {
    const current = workItemsById[workItemId];
    if (!current || current.type !== 'task') {
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

  const renderConnectionLabel = (): ReactNode => {
    const label =
      connectionState === 'live'
        ? 'Live'
        : connectionState === 'connecting'
          ? 'Connecting'
          : connectionState === 'reconnecting'
            ? 'Reconnecting'
            : 'Stale';
    return (
      <div className="board-connection">
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

  const renderTaskCard = (task: DashboardWorkItemSnapshot): ReactNode => {
    const moving = movingWorkItemIds.has(task.id);
    const selected = selectedWorkItemId === task.id;

    return (
      <li key={task.id} className={`board-card ${selected ? 'board-card--selected' : ''}`}>
        <button
          className="board-card__select"
          type="button"
          onClick={() => setSelectedWorkItemId(task.id)}
          aria-pressed={selected}
        >
          <span className="board-card__title">{task.title}</span>
          <span className="meta-text">#{task.id}</span>
        </button>
        <select
          id={`move-${task.id}`}
          className="board-card__move"
          value={isTaskStatus(task.status) ? task.status : 'Draft'}
          onChange={(event) => {
            void handleMove(task.id, event.target.value);
          }}
          disabled={moving}
          aria-disabled={moving}
          aria-label={`Move ${task.title}`}
        >
          {taskWorkItemStatuses.map(status => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </li>
    );
  };

  const renderColumn = (status: TaskWorkItemStatus): ReactNode => {
    const tasks = tasksByStatus[status];
    return (
      <section key={status} className="board-column" aria-label={`Tasks ${status}`}>
        <header className="board-column__header">
          <h4>{status}</h4>
          <span className="meta-text">{tasks.length}</span>
        </header>
        {tasks.length === 0 ? (
          <p className="meta-text board-column__empty">No tasks.</p>
        ) : (
          <ul className="board-column__list" aria-label={`${status} tasks`}>
            {tasks.map(renderTaskCard)}
          </ul>
        )}
      </section>
    );
  };

  const clearSelection = () => setSelectedWorkItemId(null);

  const renderDetails = (): ReactNode => {
    if (!selectedWorkItem) {
      return <p>Select a task to inspect details.</p>;
    }

    return (
      <div className="page-stack">
        <div className="board-detail__header">
          <h4 className="board-detail__title">{selectedWorkItem.title}</h4>
          <ActionButton tone="secondary" onClick={clearSelection}>
            Clear
          </ActionButton>
        </div>

        <ul className="entity-list board-detail__list">
          <li>
            <span>Id</span>
            <span>#{selectedWorkItem.id}</span>
          </li>
          <li>
            <span>Type</span>
            <span>{selectedWorkItem.type}</span>
          </li>
          <li>
            <span>Status</span>
            <span>{selectedWorkItem.status}</span>
          </li>
        </ul>

        <div className="board-detail__section">
          <h5>Parent chain</h5>
          {selectedParentChain.length === 0 ? (
            <p className="meta-text">None</p>
          ) : (
            <ol className="entity-list board-parent-chain">
              {selectedParentChain.map(parent => (
                <li key={parent.id}>
                  <span>{parent.type}</span>
                  <span>
                    {parent.title} <span className="meta-text">#{parent.id}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="board-detail__section">
          <h5>Planned files</h5>
          {renderStringList(selectedWorkItem.plannedFiles)}
        </div>

        <div className="board-detail__section">
          <h5>Assignees</h5>
          {renderStringList(selectedWorkItem.assignees)}
        </div>
      </div>
    );
  };

  return (
    <div className="page-stack">
      <div className="board-page-header">
        <div>
          <h2 className="board-page-title">{repository.name} board</h2>
          <p className="meta-text">Repo-scoped tasks grouped by status with realtime updates.</p>
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

      <div className="board-layout">
        <Card title="Tasks" description="Move tasks between columns to update status.">
          <div className="board-columns" role="region" aria-label="Task board">
            {taskWorkItemStatuses.map(renderColumn)}
          </div>
        </Card>

        <Panel title="Task details" description="Selection details (parents, planned files, assignees).">
          {renderDetails()}
        </Panel>
      </div>
    </div>
  );
}
