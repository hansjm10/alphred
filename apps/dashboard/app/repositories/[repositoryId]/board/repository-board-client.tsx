'use client';

import { taskWorkItemStatuses, type TaskWorkItemStatus } from '@alphred/shared';
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
import { ActionButton, ButtonLink } from '../../../ui/primitives';
import type { BoardConnectionState, BoardEventSnapshot, WorkItemActor } from '../_shared/work-items-shared';
import {
  applyBoardEventToWorkItems,
  buildParentChain,
  fetchWorkItem,
  isRecord,
  moveWorkItemStatus,
  parseBoardEventSnapshot,
  parseJsonSafely,
  requestWorkItemReplan,
  toWorkItemsById,
} from '../_shared/work-items-shared';

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
  return parseBoardEventSnapshot(payload);
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

function toUniqueSortedStrings(items: string[] | null | undefined): string[] {
  if (!items || items.length === 0) {
    return [];
  }
  return [...new Set(items)].sort((left, right) => left.localeCompare(right));
}

function resolvePlanVsActualDelta(
  plannedFiles: string[] | null,
  touchedFiles: string[] | null | undefined,
): {
  plannedButUntouched: string[];
  touchedButUnplanned: string[];
} {
  const planned = toUniqueSortedStrings(plannedFiles);
  const touched = toUniqueSortedStrings(touchedFiles);
  const plannedSet = new Set(planned);
  const touchedSet = new Set(touched);

  return {
    plannedButUntouched: planned.filter((path) => !touchedSet.has(path)),
    touchedButUnplanned: touched.filter((path) => !plannedSet.has(path)),
  };
}

function renderConcurrencyBudget(value: number | null): string {
  return value === null ? 'Unlimited' : String(value);
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
  const [replanningWorkItemIds, setReplanningWorkItemIds] = useState<ReadonlySet<number>>(() => new Set());
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
      setWorkItemsById(previous => applyBoardEventToWorkItems(previous, repository.id, parsed));
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

  const handleRequestReplan = async (workItem: DashboardWorkItemSnapshot) => {
    setActionMessage(null);
    setReplanningWorkItemIds((previous) => new Set([...previous, workItem.id]));

    try {
      const result = await requestWorkItemReplan({
        repositoryId: repository.id,
        workItemId: workItem.id,
        actor,
      });

      if (!result.ok) {
        setActionMessage({ tone: 'error', message: result.message });
        return;
      }

      const plannedGapCount = result.result.plannedButUntouched.length;
      const touchedGapCount = result.result.touchedButUnplanned.length;
      setActionMessage({
        tone: 'success',
        message:
          plannedGapCount + touchedGapCount > 0
            ? `Replanning requested for "${workItem.title}" (${plannedGapCount} planned-only, ${touchedGapCount} touched-only).`
            : `Replanning requested for "${workItem.title}".`,
      });
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to request replanning.',
      });
    } finally {
      setReplanningWorkItemIds((previous) => {
        const next = new Set(previous);
        next.delete(workItem.id);
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
    const linkedWorkflowRun = selectedWorkItem.linkedWorkflowRun ?? null;
    const moving = movingWorkItemIds.has(selectedWorkItem.id);
    const dialogTitleId = `board-detail-dialog-title-${selectedWorkItem.id}`;
    const statusSelectId = `board-detail-status-${selectedWorkItem.id}`;
    const detailTypeLabel = selectedWorkItem.type.charAt(0).toUpperCase() + selectedWorkItem.type.slice(1);
    const effectivePolicy = selectedWorkItem.effectivePolicy ?? null;
    const touchedFiles = linkedWorkflowRun?.touchedFiles;
    const planVsActual = resolvePlanVsActualDelta(selectedWorkItem.plannedFiles, touchedFiles);
    const hasMismatch = planVsActual.plannedButUntouched.length > 0 || planVsActual.touchedButUnplanned.length > 0;
    const canComparePlanVsActual = linkedWorkflowRun !== null;
    const requestingReplan = replanningWorkItemIds.has(selectedWorkItem.id);

    return (
      <div className="board-drawer-scrim">
        <button
          type="button"
          className="board-drawer-scrim__backdrop"
          onClick={clearSelection}
          aria-label="Close work item details"
          title="Close"
        />
        <dialog className="board-drawer" open aria-modal="true" aria-labelledby={dialogTitleId} aria-busy={moving || undefined}>
          <header className="board-drawer__header">
            <span className="board-drawer__kicker meta-text">{detailTypeLabel}</span>
            <ActionButton
              tone="secondary"
              className="board-drawer__close"
              onClick={clearSelection}
              aria-label="Close work item details"
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
                        <button type="button" onClick={() => setSelectedWorkItemId(parent.id)}>
                          {parent.title}
                        </button>
                      )}{' '}
                      <span className="meta-text">#{parent.id}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Linked run</h5>
            {linkedWorkflowRun ? (
              <p>
                <Link href={`/runs/${linkedWorkflowRun.workflowRunId}`}>Run #{linkedWorkflowRun.workflowRunId}</Link>{' '}
                <span className="meta-text">{linkedWorkflowRun.runStatus}</span>
              </p>
            ) : (
              <p className="meta-text">None</p>
            )}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Planned files</h5>
            {renderStringList(selectedWorkItem.plannedFiles)}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Touched files</h5>
            {linkedWorkflowRun === null ? (
              <p className="meta-text">Link a run to compare actual file touches.</p>
            ) : touchedFiles === null ? (
              <p className="meta-text">Touched files are unavailable because the linked run worktree is unavailable.</p>
            ) : (
              renderStringList(touchedFiles ?? null)
            )}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Plan vs actual</h5>
            {!canComparePlanVsActual ? (
              <p className="meta-text">No plan-vs-actual diff available yet.</p>
            ) : (
              <>
                <h6 className="meta-text">Planned but not touched</h6>
                {renderStringList(planVsActual.plannedButUntouched)}
                <h6 className="meta-text">Touched but not planned</h6>
                {renderStringList(planVsActual.touchedButUnplanned)}
                <ActionButton
                  tone="secondary"
                  onClick={() => {
                    void handleRequestReplan(selectedWorkItem);
                  }}
                  disabled={requestingReplan}
                  aria-disabled={requestingReplan}
                >
                  {requestingReplan ? 'Requesting replanning…' : hasMismatch ? 'Request replanning for mismatch' : 'Request replanning'}
                </ActionButton>
              </>
            )}
          </div>

          <div className="board-detail__section board-detail__section--divider">
            <h5>Assignees</h5>
            {renderStringList(selectedWorkItem.assignees)}
          </div>

          {effectivePolicy ? (
            <div className="board-detail__section board-detail__section--divider">
              <h5>Effective policy</h5>
              <p className="meta-text">
                Repo policy #{effectivePolicy.repositoryPolicyId ?? 'none'} · Epic policy #{effectivePolicy.epicPolicyId ?? 'none'}
              </p>
              <h6 className="meta-text">Allowed providers</h6>
              {renderStringList(effectivePolicy.policy.allowedProviders)}
              <h6 className="meta-text">Allowed models</h6>
              {renderStringList(effectivePolicy.policy.allowedModels)}
              <h6 className="meta-text">Allowed skill identifiers</h6>
              {renderStringList(effectivePolicy.policy.allowedSkillIdentifiers)}
              <h6 className="meta-text">Allowed MCP server identifiers</h6>
              {renderStringList(effectivePolicy.policy.allowedMcpServerIdentifiers)}
              <h6 className="meta-text">Budgets</h6>
              <ul className="board-detail__list">
                <li>Max concurrent tasks: {renderConcurrencyBudget(effectivePolicy.policy.budgets.maxConcurrentTasks)}</li>
                <li>Max concurrent runs: {renderConcurrencyBudget(effectivePolicy.policy.budgets.maxConcurrentRuns)}</li>
              </ul>
              <h6 className="meta-text">Required gates</h6>
              <ul className="board-detail__list">
                <li>
                  Breakdown approval required:{' '}
                  {effectivePolicy.policy.requiredGates.breakdownApprovalRequired ? 'Yes' : 'No'}
                </li>
              </ul>
            </div>
          ) : null}
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
          <div className="board-page-header__actions">
            <ButtonLink href={`/repositories/${repository.id}/stories`} tone="secondary">
              Stories
            </ButtonLink>
            {renderConnectionLabel()}
          </div>
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
