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
  updateWorkItemFields,
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

type PlanVsActualDelta = ReturnType<typeof resolvePlanVsActualDelta>;

type ParentChainEntry = Readonly<{
  id: number;
  title: string;
  type: DashboardWorkItemSnapshot['type'];
}>;

type TaskFlyoutDraft = Readonly<{
  workItemId: number;
  status: TaskWorkItemStatus;
  plannedFiles: string[];
  plannedFileInput: string;
  assignees: string[];
  assigneeInput: string;
}>;

function createTaskFlyoutDraft(workItem: DashboardWorkItemSnapshot, status: TaskWorkItemStatus): TaskFlyoutDraft {
  return {
    workItemId: workItem.id,
    status,
    plannedFiles: toUniqueSortedStrings(workItem.plannedFiles),
    plannedFileInput: '',
    assignees: toUniqueSortedStrings(workItem.assignees),
    assigneeInput: '',
  };
}

function hasTaskFlyoutTrackedFieldChanges(
  draft: Pick<TaskFlyoutDraft, 'status' | 'plannedFiles' | 'assignees'>,
  baseline: Pick<TaskFlyoutDraft, 'status' | 'plannedFiles' | 'assignees'>,
): boolean {
  return (
    draft.status !== baseline.status ||
    !areSortedStringArraysEqual(draft.plannedFiles, baseline.plannedFiles) ||
    !areSortedStringArraysEqual(draft.assignees, baseline.assignees)
  );
}

function rebaseTaskFlyoutDraft(
  previousDraft: TaskFlyoutDraft,
  baselineDraft: TaskFlyoutDraft,
  nextSnapshotDraft: TaskFlyoutDraft,
): TaskFlyoutDraft {
  const statusWasEdited = previousDraft.status !== baselineDraft.status;

  return {
    ...nextSnapshotDraft,
    status: statusWasEdited ? previousDraft.status : nextSnapshotDraft.status,
    plannedFiles: rebaseEditedSortedStringArray(previousDraft.plannedFiles, baselineDraft.plannedFiles, nextSnapshotDraft.plannedFiles),
    plannedFileInput: previousDraft.plannedFileInput,
    assignees: rebaseEditedSortedStringArray(previousDraft.assignees, baselineDraft.assignees, nextSnapshotDraft.assignees),
    assigneeInput: previousDraft.assigneeInput,
  };
}

function rebaseEditedSortedStringArray(
  previousValues: readonly string[],
  baselineValues: readonly string[],
  nextSnapshotValues: readonly string[],
): string[] {
  if (areSortedStringArraysEqual(previousValues, baselineValues)) {
    return [...nextSnapshotValues];
  }

  const baselineSet = new Set(baselineValues);
  const previousSet = new Set(previousValues);
  const rebasedValues = new Set(nextSnapshotValues);

  for (const baselineValue of baselineSet) {
    if (!previousSet.has(baselineValue)) {
      rebasedValues.delete(baselineValue);
    }
  }

  for (const previousValue of previousSet) {
    if (!baselineSet.has(previousValue)) {
      rebasedValues.add(previousValue);
    }
  }

  return toUniqueSortedStrings([...rebasedValues]);
}

function areSortedStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
}

function toNullableStringArray(items: readonly string[]): string[] | null {
  return items.length > 0 ? [...items] : null;
}

function normalizeRepoRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
}

function splitPath(path: string): { filename: string; directory: string } {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash < 0) {
    return { filename: path, directory: '' };
  }
  return {
    filename: path.slice(lastSlash + 1),
    directory: path.slice(0, lastSlash + 1),
  };
}

function buildRepositoryFileUrl(repository: DashboardRepositoryState, path: string): string | null {
  if (repository.provider !== 'github') {
    return null;
  }
  const remoteRef = repository.remoteRef.trim();
  if (remoteRef.length === 0) {
    return null;
  }
  const encodedPath = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `https://github.com/${remoteRef}/blob/${encodeURIComponent(repository.defaultBranch)}/${encodedPath}`;
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

function getReplanActionLabel(requestingReplan: boolean, hasMismatch: boolean): string {
  if (requestingReplan) {
    return 'Requesting replanning…';
  }
  if (hasMismatch) {
    return 'Request replanning for mismatch';
  }
  return 'Request replanning';
}

function renderTaskStatusIcon(status: TaskWorkItemStatus): ReactNode {
  const commonProps = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'board-status-icon',
  };

  switch (status) {
    case 'Draft':
      return (
        <svg {...commonProps}>
          <circle cx="6" cy="6" r="4.25" />
        </svg>
      );
    case 'Ready':
      return (
        <svg {...commonProps}>
          <path d="M2.4 6h7.2" />
          <path d="M6.3 3.6 9 6l-2.7 2.4" />
        </svg>
      );
    case 'InProgress':
      return (
        <svg {...commonProps}>
          <path d="M2.1 6A3.9 3.9 0 1 1 6 9.9" />
          <path d="M5.7 2.1h2.4v2.4" />
        </svg>
      );
    case 'Blocked':
      return (
        <svg {...commonProps}>
          <circle cx="6" cy="6" r="4.25" />
          <path d="M3.4 8.6 8.6 3.4" />
        </svg>
      );
    case 'InReview':
      return (
        <svg {...commonProps}>
          <path d="M1.8 6s1.8-2.9 4.2-2.9S10.2 6 10.2 6 8.4 8.9 6 8.9 1.8 6 1.8 6Z" />
          <circle cx="6" cy="6" r="1.2" />
        </svg>
      );
    case 'Done':
      return (
        <svg {...commonProps}>
          <path d="M2.2 6.3 4.8 8.9 9.8 3.9" />
        </svg>
      );
  }
}

function renderStatusControl({
  status,
  statusSelectId,
  disabled,
  onStatusChange,
}: Readonly<{
  status: TaskWorkItemStatus | null;
  statusSelectId: string;
  disabled: boolean;
  onStatusChange: (nextStatusRaw: string) => void;
}>): ReactNode {
  if (status === null) {
    return null;
  }

  return (
    <div className="board-drawer__control board-drawer__control--status">
      <label htmlFor={statusSelectId} className="meta-text">
        Status
      </label>
      <div className={`board-status-select board-status-select--${status}`} data-status={status}>
        {renderTaskStatusIcon(status)}
        <select
          id={statusSelectId}
          value={status}
          onChange={(event) => {
            onStatusChange(event.target.value);
          }}
          disabled={disabled}
          aria-disabled={disabled}
          className="board-drawer__select board-drawer__select--status"
        >
          {taskWorkItemStatuses.map(entry => (
            <option key={entry} value={entry}>
              {formatTaskStatusLabel(entry)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function renderParentChainSection({
  parentChain,
  repositoryId,
  onSelectWorkItem,
  onLinkParent,
}: Readonly<{
  parentChain: readonly ParentChainEntry[];
  repositoryId: number;
  onSelectWorkItem: (workItemId: number) => void;
  onLinkParent: () => void;
}>): ReactNode {
  return (
    <div className="board-detail__section">
      <h5>Parent</h5>
      {parentChain.length === 0 ? (
        <div className="board-detail__empty">
          <span className="meta-text">No parent</span>
          <ActionButton tone="secondary" className="board-inline-action" onClick={onLinkParent}>
            Link parent…
          </ActionButton>
        </div>
      ) : (
        <>
          <ol className="board-parent-chain">
            {parentChain.map(parent => (
              <li key={parent.id}>
                <span className="board-pill">{parent.type}</span>
                <span>
                  {parent.type === 'story' ? (
                    <Link href={`/repositories/${repositoryId}/stories/${parent.id}`}>{parent.title}</Link>
                  ) : (
                    <button type="button" onClick={() => onSelectWorkItem(parent.id)}>
                      {parent.title}
                    </button>
                  )}{' '}
                  <span className="meta-text">#{parent.id}</span>
                </span>
              </li>
            ))}
          </ol>
          <ActionButton tone="secondary" className="board-inline-action" onClick={onLinkParent}>
            Change parent…
          </ActionButton>
        </>
      )}
    </div>
  );
}

function renderLinkedRun(linkedWorkflowRun: DashboardWorkItemSnapshot['linkedWorkflowRun'] | null): ReactNode {
  if (linkedWorkflowRun == null) {
    return <p className="meta-text">None</p>;
  }

  return (
    <p>
      <Link href={`/runs/${linkedWorkflowRun.workflowRunId}`}>Run #{linkedWorkflowRun.workflowRunId}</Link>{' '}
      <span className="meta-text">{linkedWorkflowRun.runStatus}</span>
    </p>
  );
}

function renderTouchedFiles({
  linkedWorkflowRun,
  hasTouchedFiles,
  touchedFiles,
}: Readonly<{
  linkedWorkflowRun: DashboardWorkItemSnapshot['linkedWorkflowRun'] | null;
  hasTouchedFiles: boolean;
  touchedFiles: string[] | null | undefined;
}>): ReactNode {
  if (linkedWorkflowRun == null) {
    return <p className="meta-text">Link a run to compare actual file touches.</p>;
  }
  if (hasTouchedFiles === false) {
    return <p className="meta-text">Touched files are unavailable because the linked run worktree is unavailable.</p>;
  }
  return renderStringList(touchedFiles ?? null);
}

function renderPlanVsActual({
  canComparePlanVsActual,
  planVsActual,
  requestingReplan,
  onRequestReplan,
}: Readonly<{
  canComparePlanVsActual: boolean;
  planVsActual: PlanVsActualDelta;
  requestingReplan: boolean;
  onRequestReplan: () => void;
}>): ReactNode {
  if (canComparePlanVsActual) {
    const hasMismatch = planVsActual.plannedButUntouched.length > 0 || planVsActual.touchedButUnplanned.length > 0;
    return (
      <>
        <h6 className="meta-text">Planned but not touched</h6>
        {renderStringList(planVsActual.plannedButUntouched)}
        <h6 className="meta-text">Touched but not planned</h6>
        {renderStringList(planVsActual.touchedButUnplanned)}
        <ActionButton tone="secondary" onClick={onRequestReplan} disabled={requestingReplan} aria-disabled={requestingReplan}>
          {getReplanActionLabel(requestingReplan, hasMismatch)}
        </ActionButton>
      </>
    );
  }

  return <p className="meta-text">No plan-vs-actual diff available yet.</p>;
}

function renderEffectivePolicy(effectivePolicy: DashboardWorkItemSnapshot['effectivePolicy'] | null): ReactNode {
  if (effectivePolicy == null) {
    return null;
  }

  return (
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
          Breakdown approval required: {effectivePolicy.policy.requiredGates.breakdownApprovalRequired ? 'Yes' : 'No'}
        </li>
      </ul>
    </div>
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
  const [replanningWorkItemIds, setReplanningWorkItemIds] = useState<ReadonlySet<number>>(() => new Set());
  const [activeDragWorkItemId, setActiveDragWorkItemId] = useState<number | null>(null);
  const [taskDraft, setTaskDraft] = useState<TaskFlyoutDraft | null>(null);

  const lastEventIdRef = useRef<number>(initialLatestEventId);
  const selectedWorkItemIdRef = useRef<number | null>(selectedWorkItemId);
  const taskDraftDirtyRef = useRef<boolean>(false);
  const taskDraftBaselineRef = useRef<TaskFlyoutDraft | null>(null);

  selectedWorkItemIdRef.current = selectedWorkItemId;

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
  const knownAssigneeOptions = useMemo(() => {
    const values: string[] = [];
    for (const workItem of Object.values(workItemsById)) {
      values.push(...(workItem.assignees ?? []));
    }
    return toUniqueSortedStrings(values);
  }, [workItemsById]);

  useEffect(() => {
    if (!selectedWorkItem || selectedWorkItem.type !== 'task' || !isTaskStatus(selectedWorkItem.status)) {
      setTaskDraft(null);
      taskDraftDirtyRef.current = false;
      taskDraftBaselineRef.current = null;
      return;
    }

    const nextSnapshotDraft = createTaskFlyoutDraft(selectedWorkItem, selectedWorkItem.status as TaskWorkItemStatus);
    setTaskDraft(previous => {
      if (previous && previous.workItemId === selectedWorkItem.id && taskDraftDirtyRef.current) {
        const baseline = taskDraftBaselineRef.current;
        const rebasedDraft =
          baseline && baseline.workItemId === selectedWorkItem.id
            ? rebaseTaskFlyoutDraft(previous, baseline, nextSnapshotDraft)
            : {
                ...nextSnapshotDraft,
                status: previous.status,
                plannedFiles: [...previous.plannedFiles],
                plannedFileInput: previous.plannedFileInput,
                assignees: [...previous.assignees],
                assigneeInput: previous.assigneeInput,
              };
        taskDraftBaselineRef.current = nextSnapshotDraft;
        taskDraftDirtyRef.current =
          hasTaskFlyoutTrackedFieldChanges(rebasedDraft, nextSnapshotDraft) ||
          rebasedDraft.plannedFileInput.length > 0 ||
          rebasedDraft.assigneeInput.length > 0;
        return rebasedDraft;
      }
      taskDraftDirtyRef.current = false;
      taskDraftBaselineRef.current = nextSnapshotDraft;
      return nextSnapshotDraft;
    });
  }, [selectedWorkItem]);

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

  const resetTaskDraftFromSnapshot = (workItem: DashboardWorkItemSnapshot): void => {
    if (workItem.type !== 'task' || !isTaskStatus(workItem.status)) {
      return;
    }
    if (selectedWorkItemIdRef.current !== workItem.id) {
      return;
    }
    const nextDraft = createTaskFlyoutDraft(workItem, workItem.status);
    taskDraftBaselineRef.current = nextDraft;
    taskDraftDirtyRef.current = false;
    setTaskDraft(nextDraft);
  };

  const refreshWorkItemFromServer = async (workItemId: number, conflictMessage: string): Promise<DashboardWorkItemSnapshot | null> => {
    try {
      const refreshed = await fetchWorkItem({ repositoryId: repository.id, workItemId });
      setWorkItemsById(previous => ({
        ...previous,
        [workItemId]: refreshed,
      }));
      resetTaskDraftFromSnapshot(refreshed);
      setActionMessage({ tone: 'error', message: `${conflictMessage} Refreshed from server.` });
      return refreshed;
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to refresh work item.',
      });
      return null;
    }
  };

  const handleDraftPlannedFileInput = (value: string): void => {
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => (previous ? { ...previous, plannedFileInput: value } : previous));
  };

  const handleAddDraftPlannedFile = (): void => {
    if (!taskDraft) {
      return;
    }

    const normalized = normalizeRepoRelativePath(taskDraft.plannedFileInput);
    if (!normalized) {
      setActionMessage({ tone: 'error', message: 'Enter a repo-relative path (for example: app/page.tsx).' });
      return;
    }

    setActionMessage(null);
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        plannedFiles: toUniqueSortedStrings([...previous.plannedFiles, normalized]),
        plannedFileInput: '',
      };
    });
  };

  const handleRemoveDraftPlannedFile = (path: string): void => {
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        plannedFiles: previous.plannedFiles.filter(entry => entry !== path),
      };
    });
  };

  const handleDraftAssigneeInput = (value: string): void => {
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => (previous ? { ...previous, assigneeInput: value } : previous));
  };

  const handleAddDraftAssignee = (): void => {
    if (!taskDraft) {
      return;
    }

    const candidate = taskDraft.assigneeInput.trim();
    if (candidate.length === 0) {
      setActionMessage({ tone: 'error', message: 'Enter an assignee name.' });
      return;
    }

    setActionMessage(null);
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        assignees: toUniqueSortedStrings([...previous.assignees, candidate]),
        assigneeInput: '',
      };
    });
  };

  const handleRemoveDraftAssignee = (assignee: string): void => {
    taskDraftDirtyRef.current = true;
    setTaskDraft(previous => {
      if (!previous) {
        return previous;
      }
      return {
        ...previous,
        assignees: previous.assignees.filter(entry => entry !== assignee),
      };
    });
  };

  const handleCopyPlannedFile = async (path: string): Promise<void> => {
    const copied = await copyTextToClipboard(path);
    setActionMessage(
      copied
        ? { tone: 'success', message: 'Copied file path to clipboard.' }
        : { tone: 'error', message: 'Unable to copy path in this environment.' },
    );
  };

  const handleLinkParent = (): void => {
    setActionMessage({
      tone: 'error',
      message: 'Parent relinking is not available in this flyout yet. Open the related story page to adjust hierarchy.',
    });
  };

  const handleSaveTaskDraft = async (): Promise<void> => {
    if (!selectedWorkItem || selectedWorkItem.type !== 'task' || !isTaskStatus(selectedWorkItem.status)) {
      return;
    }
    if (!taskDraft || taskDraft.workItemId !== selectedWorkItem.id) {
      return;
    }

    const statusChanged = taskDraft.status !== selectedWorkItem.status;
    const nextPlannedFiles = toUniqueSortedStrings(taskDraft.plannedFiles);
    const nextAssignees = toUniqueSortedStrings(taskDraft.assignees);
    const currentPlannedFiles = toUniqueSortedStrings(selectedWorkItem.plannedFiles);
    const currentAssignees = toUniqueSortedStrings(selectedWorkItem.assignees);
    const plannedFilesChanged = !areSortedStringArraysEqual(nextPlannedFiles, currentPlannedFiles);
    const assigneesChanged = !areSortedStringArraysEqual(nextAssignees, currentAssignees);

    if (!statusChanged && !plannedFilesChanged && !assigneesChanged) {
      return;
    }

    const workItemId = selectedWorkItem.id;
    setActionMessage(null);
    setMovingWorkItemIds(previous => new Set([...previous, workItemId]));

    try {
      let latest = selectedWorkItem;

      if (statusChanged) {
        const moveResult = await moveWorkItemStatus({
          repositoryId: repository.id,
          workItemId,
          expectedRevision: latest.revision,
          toStatus: taskDraft.status,
          actor,
        });

        if (!moveResult.ok) {
          if (moveResult.status === 409) {
            await refreshWorkItemFromServer(workItemId, moveResult.message);
            return;
          }
          setActionMessage({ tone: 'error', message: moveResult.message });
          return;
        }

        latest = moveResult.workItem;
        setWorkItemsById(previous => ({
          ...previous,
          [workItemId]: latest,
        }));
      }

      if (plannedFilesChanged || assigneesChanged) {
        const updateResult = await updateWorkItemFields({
          repositoryId: repository.id,
          workItemId,
          expectedRevision: latest.revision,
          actor,
          ...(plannedFilesChanged ? { plannedFiles: toNullableStringArray(nextPlannedFiles) } : {}),
          ...(assigneesChanged ? { assignees: toNullableStringArray(nextAssignees) } : {}),
        });

        if (!updateResult.ok) {
          if (updateResult.status === 409) {
            await refreshWorkItemFromServer(workItemId, updateResult.message);
            return;
          }
          setActionMessage({ tone: 'error', message: updateResult.message });
          return;
        }

        latest = updateResult.workItem;
        setWorkItemsById(previous => ({
          ...previous,
          [workItemId]: latest,
        }));
      }

      resetTaskDraftFromSnapshot(latest);
      setActionMessage({ tone: 'success', message: `Saved updates for "${latest.title}".` });
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to save task updates.',
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

    let status: TaskWorkItemStatus | null = null;
    if (selectedWorkItem.type === 'task' && isTaskStatus(selectedWorkItem.status)) {
      status = selectedWorkItem.status;
    }
    const linkedWorkflowRun = selectedWorkItem.linkedWorkflowRun ?? null;
    const moving = movingWorkItemIds.has(selectedWorkItem.id);
    const dialogTitleId = `board-detail-dialog-title-${selectedWorkItem.id}`;
    const statusSelectId = `board-detail-status-${selectedWorkItem.id}`;
    const detailTypeLabel = selectedWorkItem.type.charAt(0).toUpperCase() + selectedWorkItem.type.slice(1);
    const effectivePolicy = selectedWorkItem.effectivePolicy ?? null;
    const touchedFiles = linkedWorkflowRun?.touchedFiles;
    const hasTouchedFiles = touchedFiles !== null && touchedFiles !== undefined;
    const canComparePlanVsActual = linkedWorkflowRun !== null && hasTouchedFiles;
    const planVsActual = canComparePlanVsActual
      ? resolvePlanVsActualDelta(selectedWorkItem.plannedFiles, touchedFiles)
      : { plannedButUntouched: [], touchedButUnplanned: [] };
    const requestingReplan = replanningWorkItemIds.has(selectedWorkItem.id);
    const parentStory = [...selectedParentChain].reverse().find(parent => parent.type === 'story') ?? null;
    const openFullPageHref = parentStory ? `/repositories/${repository.id}/stories/${parentStory.id}` : null;
    const draftMatchesSelection = taskDraft !== null && taskDraft.workItemId === selectedWorkItem.id;
    const draftStatus = draftMatchesSelection && status !== null ? taskDraft.status : status;
    const draftedPlannedFiles = draftMatchesSelection ? toUniqueSortedStrings(taskDraft.plannedFiles) : toUniqueSortedStrings(selectedWorkItem.plannedFiles);
    const draftedAssignees = draftMatchesSelection ? toUniqueSortedStrings(taskDraft.assignees) : toUniqueSortedStrings(selectedWorkItem.assignees);
    const currentPlannedFiles = toUniqueSortedStrings(selectedWorkItem.plannedFiles);
    const currentAssignees = toUniqueSortedStrings(selectedWorkItem.assignees);
    const statusChanged = status !== null && draftStatus !== null && draftStatus !== status;
    const plannedFilesChanged = !areSortedStringArraysEqual(draftedPlannedFiles, currentPlannedFiles);
    const assigneesChanged = !areSortedStringArraysEqual(draftedAssignees, currentAssignees);
    const hasDraftChanges = draftMatchesSelection && (statusChanged || plannedFilesChanged || assigneesChanged);
    const canEditDraft = draftMatchesSelection && !moving;
    const fileInputId = `board-detail-file-input-${selectedWorkItem.id}`;
    const assigneeInputId = `board-detail-assignee-input-${selectedWorkItem.id}`;
    const assigneeOptionsId = `board-detail-assignee-options-${selectedWorkItem.id}`;
    const metadataLabel = `${detailTypeLabel} · #${selectedWorkItem.id}`;

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
            <span className="board-drawer__kicker meta-text">{metadataLabel}</span>
            <div className="board-drawer__header-actions">
              {openFullPageHref ? (
                <ButtonLink href={openFullPageHref} tone="secondary" className="board-drawer__open-link">
                  Open full page
                </ButtonLink>
              ) : null}
              <ActionButton
                tone="secondary"
                className="board-drawer__close"
                onClick={clearSelection}
                aria-label="Close work item details"
                title="Close"
              >
                ×
              </ActionButton>
            </div>
          </header>

          <div className="board-drawer__summary">
            <h3 className="board-drawer__title" id={dialogTitleId}>
              {selectedWorkItem.title}
            </h3>
          </div>

          {renderStatusControl({
            status: draftStatus,
            statusSelectId,
            disabled: !canEditDraft,
            onStatusChange: (nextStatusRaw) => {
              if (!isTaskStatus(nextStatusRaw)) {
                setActionMessage({ tone: 'error', message: 'Invalid target status.' });
                return;
              }
              setActionMessage(null);
              taskDraftDirtyRef.current = true;
              setTaskDraft(previous => {
                if (!previous || previous.workItemId !== selectedWorkItem.id) {
                  return previous;
                }
                return {
                  ...previous,
                  status: nextStatusRaw,
                };
              });
            },
          })}

          {renderParentChainSection({
            parentChain: selectedParentChain,
            repositoryId: repository.id,
            onSelectWorkItem: setSelectedWorkItemId,
            onLinkParent: handleLinkParent,
          })}

          <div className="board-detail__section">
            <h5>Files ({draftedPlannedFiles.length})</h5>
            {draftedPlannedFiles.length === 0 ? (
              <p className="meta-text">No files linked yet.</p>
            ) : (
              <ul className="board-file-list">
                {draftedPlannedFiles.map(path => {
                  const split = splitPath(path);
                  const openFileHref = buildRepositoryFileUrl(repository, path);
                  return (
                    <li key={path} className="board-file-list__item">
                      <div className="board-file-list__content">
                        <span className="board-file-list__name">{split.filename}</span>
                        <code className="board-file-list__path">{split.directory.length > 0 ? split.directory : './'}</code>
                      </div>
                      <div className="board-file-list__actions">
                        <ActionButton
                          tone="secondary"
                          className="board-file-action"
                          onClick={() => {
                            void handleCopyPlannedFile(path);
                          }}
                          aria-label={`Copy path ${path}`}
                          title="Copy path"
                        >
                          Copy
                        </ActionButton>
                        {openFileHref ? (
                          <a
                            href={openFileHref}
                            target="_blank"
                            rel="noreferrer"
                            className="button-link button-link--secondary board-file-action"
                            aria-label={`Open ${path} in GitHub`}
                          >
                            Open
                          </a>
                        ) : (
                          <ActionButton
                            tone="secondary"
                            className="board-file-action"
                            disabled
                            aria-disabled="true"
                            title="Open file links are available for GitHub repositories."
                          >
                            Open
                          </ActionButton>
                        )}
                        <ActionButton
                          tone="secondary"
                          className="board-file-action"
                          disabled={!canEditDraft}
                          aria-disabled={!canEditDraft}
                          onClick={() => {
                            handleRemoveDraftPlannedFile(path);
                          }}
                          aria-label={`Remove planned file ${path}`}
                        >
                          Remove
                        </ActionButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="board-inline-editor">
              <input
                id={fileInputId}
                value={draftMatchesSelection ? taskDraft.plannedFileInput : ''}
                onChange={(event) => {
                  handleDraftPlannedFileInput(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAddDraftPlannedFile();
                  }
                }}
                placeholder="Add repo-relative file path"
                disabled={!canEditDraft}
                aria-disabled={!canEditDraft}
                aria-label="Add planned file path"
              />
              <ActionButton
                tone="secondary"
                className="board-inline-action"
                disabled={!canEditDraft}
                aria-disabled={!canEditDraft}
                onClick={handleAddDraftPlannedFile}
              >
                Add file
              </ActionButton>
            </div>
          </div>

          <div className="board-detail__section">
            <h5>Assignees</h5>
            {draftedAssignees.length === 0 ? (
              <p className="meta-text">No assignees yet.</p>
            ) : (
              <ul className="board-assignee-list">
                {draftedAssignees.map(assignee => (
                  <li key={assignee}>
                    <span className="board-pill">{assignee}</span>
                    <ActionButton
                      tone="secondary"
                      className="board-inline-action"
                      disabled={!canEditDraft}
                      aria-disabled={!canEditDraft}
                      onClick={() => {
                        handleRemoveDraftAssignee(assignee);
                      }}
                      aria-label={`Remove assignee ${assignee}`}
                    >
                      Remove
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="board-inline-editor">
              <input
                id={assigneeInputId}
                value={draftMatchesSelection ? taskDraft.assigneeInput : ''}
                onChange={(event) => {
                  handleDraftAssigneeInput(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAddDraftAssignee();
                  }
                }}
                placeholder="Add assignee"
                list={assigneeOptionsId}
                disabled={!canEditDraft}
                aria-disabled={!canEditDraft}
                aria-label="Add assignee"
              />
              <datalist id={assigneeOptionsId}>
                {knownAssigneeOptions.map(candidate => (
                  <option key={candidate} value={candidate} />
                ))}
              </datalist>
              <ActionButton
                tone="secondary"
                className="board-inline-action"
                disabled={!canEditDraft}
                aria-disabled={!canEditDraft}
                onClick={handleAddDraftAssignee}
              >
                Add assignee
              </ActionButton>
            </div>
          </div>

          <div className="board-detail__section board-detail__section--muted">
            <h5>Linked run</h5>
            {renderLinkedRun(linkedWorkflowRun)}
          </div>

          <div className="board-detail__section board-detail__section--muted">
            <h5>Touched files</h5>
            {renderTouchedFiles({
              linkedWorkflowRun,
              hasTouchedFiles,
              touchedFiles,
            })}
          </div>

          <div className="board-detail__section board-detail__section--muted">
            <h5>Plan vs actual</h5>
            {renderPlanVsActual({
              canComparePlanVsActual,
              planVsActual,
              requestingReplan,
              onRequestReplan: () => {
                void handleRequestReplan(selectedWorkItem);
              },
            })}
          </div>

          {renderEffectivePolicy(effectivePolicy)}

          <footer className="board-drawer__footer">
            <ActionButton tone="secondary" onClick={clearSelection} disabled={moving} aria-disabled={moving}>
              Cancel
            </ActionButton>
            <ActionButton
              tone="primary"
              onClick={() => {
                void handleSaveTaskDraft();
              }}
              disabled={!hasDraftChanges || moving}
              aria-disabled={!hasDraftChanges || moving}
            >
              {moving ? 'Saving…' : 'Save'}
            </ActionButton>
          </footer>
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
