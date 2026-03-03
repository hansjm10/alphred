'use client';

import type { WorkItemStatus, WorkItemType } from '@alphred/shared';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DashboardRepositoryState,
  DashboardStoryBreakdownProposalSnapshot,
  DashboardWorkItemSnapshot,
} from '../../../../../src/server/dashboard-contracts';
import { ActionButton } from '../../../../ui/primitives';

type WorkItemActor = Readonly<{
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
}>;

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

type BoardConnectionState = 'connecting' | 'live' | 'reconnecting' | 'stale';

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
  if (
    !isRecord(payload) ||
    typeof payload.type !== 'string' ||
    typeof payload.status !== 'string' ||
    typeof payload.title !== 'string'
  ) {
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
  repositoryId: number,
  event: BoardEventSnapshot,
): Readonly<Record<number, DashboardWorkItemSnapshot>> {
  if (event.repositoryId !== repositoryId) {
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

function parseBoardEventSnapshot(payload: unknown): BoardEventSnapshot | null {
  if (
    !isRecord(payload) ||
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
    payload: payload.payload,
    createdAt: payload.createdAt,
  };
}

async function fetchRepositoryWorkItems(params: { repositoryId: number }): Promise<DashboardWorkItemSnapshot[]> {
  const response = await fetch(`/api/dashboard/repositories/${params.repositoryId}/work-items`, { method: 'GET' });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh work items'));
  }

  if (!isRecord(payload) || !Array.isArray(payload.workItems)) {
    throw new Error('Unable to refresh work items (malformed response).');
  }

  return payload.workItems as DashboardWorkItemSnapshot[];
}

async function fetchWorkItem(params: { repositoryId: number; workItemId: number }): Promise<DashboardWorkItemSnapshot> {
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

async function fetchBreakdownProposal(params: { repositoryId: number; storyId: number }): Promise<DashboardStoryBreakdownProposalSnapshot | null> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/breakdown?repositoryId=${params.repositoryId}`, {
    method: 'GET',
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh breakdown proposal'));
  }

  if (!isRecord(payload)) {
    throw new Error('Unable to refresh breakdown proposal (malformed response).');
  }

  return (payload.proposal ?? null) as DashboardStoryBreakdownProposalSnapshot | null;
}

async function moveWorkItemStatus(params: {
  repositoryId: number;
  workItemId: number;
  expectedRevision: number;
  toStatus: WorkItemStatus;
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
      message: resolveApiErrorMessage(response.status, payload, 'Unable to move story status'),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.workItem)) {
    return { ok: false, status: 500, message: 'Unable to move story status (malformed response).' };
  }

  return { ok: true, workItem: payload.workItem as DashboardWorkItemSnapshot };
}

async function approveStoryBreakdown(params: {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  actor: WorkItemActor;
}): Promise<
  | { ok: true; story: DashboardWorkItemSnapshot; tasks: DashboardWorkItemSnapshot[] }
  | { ok: false; status: number; message: string }
> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/approve-breakdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
      expectedRevision: params.expectedRevision,
      actorType: params.actor.actorType,
      actorLabel: params.actor.actorLabel,
    }),
  });

  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: resolveApiErrorMessage(response.status, payload, 'Unable to approve breakdown'),
    };
  }

  if (!isRecord(payload) || !isRecord(payload.story) || !Array.isArray(payload.tasks)) {
    return { ok: false, status: 500, message: 'Unable to approve breakdown (malformed response).' };
  }

  return {
    ok: true,
    story: payload.story as DashboardWorkItemSnapshot,
    tasks: payload.tasks as DashboardWorkItemSnapshot[],
  };
}

function renderStringList(values: string[] | null): ReactNode {
  if (!values || values.length === 0) {
    return <p className="meta-text">None</p>;
  }

  return (
    <ul className="board-detail__list">
      {values.map(value => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );
}

function formatWorkItemStatusLabel(status: WorkItemStatus): string {
  switch (status) {
    case 'NeedsBreakdown':
      return 'Needs breakdown';
    case 'BreakdownProposed':
      return 'Breakdown proposed';
    case 'InProgress':
      return 'In progress';
    case 'InReview':
      return 'In review';
    default:
      return status;
  }
}

export function StoryDetailPageContent(props: Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  storyId: number;
  initialLatestEventId: number;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
  initialProposal: DashboardStoryBreakdownProposalSnapshot | null;
}>) {
  const { repository, actor, storyId, initialLatestEventId, initialWorkItems, initialProposal } = props;

  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [proposal, setProposal] = useState<DashboardStoryBreakdownProposalSnapshot | null>(initialProposal);
  const [connectionState, setConnectionState] = useState<BoardConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const latestEventIdRef = useRef(initialLatestEventId);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const story = workItemsById[storyId] ?? null;
  const parentChain = useMemo(() => {
    if (!story) return [];
    return buildParentChain(story, workItemsById);
  }, [story, workItemsById]);

  const childTasks = useMemo(() => {
    if (!story) return [];
    return Object.values(workItemsById)
      .filter(item => item.type === 'task' && item.parentId === storyId)
      .sort((a, b) => a.id - b.id);
  }, [workItemsById, story, storyId]);

  const connect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const lastEventId = latestEventIdRef.current;
    setConnectionState(previous => (previous === 'connecting' ? 'connecting' : 'reconnecting'));
    setConnectionError(null);

    const eventSource = new EventSource(
      `/api/dashboard/repositories/${repository.id}/board/events?transport=sse&lastEventId=${lastEventId}`,
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('board_state', (event) => {
      const parsed = parseJsonSafely((event as MessageEvent).data);
      if (isRecord(parsed) && typeof parsed.latestEventId === 'number') {
        // board_state indicates a high watermark, but we still resume from last delivered event id.
        setConnectionState('live');
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      setConnectionState('live');
    });

    eventSource.addEventListener('board_error', (event) => {
      const parsed = parseJsonSafely((event as MessageEvent).data);
      if (isRecord(parsed) && typeof parsed.message === 'string') {
        setConnectionError(parsed.message);
      } else {
        setConnectionError('Board stream error.');
      }
    });

    eventSource.addEventListener('board_event', (event) => {
      const parsed = parseJsonSafely((event as MessageEvent).data);
      const snapshot = parseBoardEventSnapshot(parsed);
      if (!snapshot) {
        return;
      }

      latestEventIdRef.current = Math.max(latestEventIdRef.current, snapshot.id);

      setWorkItemsById(previous => applyBoardEventToWorkItems(previous, repository.id, snapshot));

      if (snapshot.workItemId === storyId && snapshot.eventType === 'breakdown_proposed') {
        const payload = snapshot.payload;
        if (isRecord(payload) && isRecord(payload.proposed)) {
          const proposed = payload.proposed as DashboardStoryBreakdownProposalSnapshot['proposed'];
          setProposal({
            eventId: snapshot.id,
            createdAt: snapshot.createdAt,
            createdTaskIds: Array.isArray(payload.createdTaskIds) ? (payload.createdTaskIds as number[]) : [],
            proposed,
          });
        }
      }

      if (snapshot.workItemId === storyId && snapshot.eventType === 'breakdown_approved') {
        setProposal(null);
      }
    });

    eventSource.onopen = () => {
      setConnectionState('live');
    };

    eventSource.onerror = () => {
      setConnectionState('stale');
      setConnectionError('Connection lost. Reconnecting…');
      eventSource.close();
      eventSourceRef.current = null;
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 1000);
    };
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [repository.id, storyId]);

  const refreshAll = async (options?: { bannerMessage?: string | null }) => {
    setBusy(true);
    if (options?.bannerMessage !== undefined) {
      setActionError(options.bannerMessage);
    } else {
      setActionError(null);
    }
    try {
      const [workItems, latestProposal, latestStory] = await Promise.all([
        fetchRepositoryWorkItems({ repositoryId: repository.id }),
        fetchBreakdownProposal({ repositoryId: repository.id, storyId }),
        fetchWorkItem({ repositoryId: repository.id, workItemId: storyId }),
      ]);
      setWorkItemsById(toWorkItemsById(workItems));
      setProposal(latestProposal);
      setWorkItemsById(previous => ({ ...previous, [latestStory.id]: latestStory }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestBreakdown = async () => {
    if (!story) return;
    setBusy(true);
    setActionError(null);
    const moveResult = await moveWorkItemStatus({
      repositoryId: repository.id,
      workItemId: story.id,
      expectedRevision: story.revision,
      toStatus: 'NeedsBreakdown',
      actor,
    });
    if (moveResult.ok) {
      setWorkItemsById(previous => ({ ...previous, [moveResult.workItem.id]: moveResult.workItem }));
    } else {
      if (moveResult.status === 409) {
        await refreshAll({ bannerMessage: `Revision conflict: ${moveResult.message}` });
      } else {
        setActionError(moveResult.message);
      }
    }
    setBusy(false);
  };

  const handleRequestChanges = async () => {
    if (!story) return;
    setBusy(true);
    setActionError(null);
    const moveResult = await moveWorkItemStatus({
      repositoryId: repository.id,
      workItemId: story.id,
      expectedRevision: story.revision,
      toStatus: 'NeedsBreakdown',
      actor,
    });
    if (moveResult.ok) {
      setProposal(null);
      setWorkItemsById(previous => ({ ...previous, [moveResult.workItem.id]: moveResult.workItem }));
    } else {
      if (moveResult.status === 409) {
        await refreshAll({ bannerMessage: `Revision conflict: ${moveResult.message}` });
      } else {
        setActionError(moveResult.message);
      }
    }
    setBusy(false);
  };

  const handleApproveBreakdown = async () => {
    if (!story) return;
    setBusy(true);
    setActionError(null);
    const approveResult = await approveStoryBreakdown({
      repositoryId: repository.id,
      storyId,
      expectedRevision: story.revision,
      actor,
    });

    if (approveResult.ok) {
      setProposal(null);
      setWorkItemsById(previous => {
        const next: Record<number, DashboardWorkItemSnapshot> = { ...previous };
        next[approveResult.story.id] = approveResult.story;
        for (const task of approveResult.tasks) {
          next[task.id] = task;
        }
        return next;
      });
    } else {
      if (approveResult.status === 409) {
        await refreshAll({ bannerMessage: `Revision conflict: ${approveResult.message}` });
      } else {
        setActionError(approveResult.message);
      }
    }

    setBusy(false);
  };

  if (!story || story.type !== 'story') {
    return (
      <div className="page-stack">
        <p className="repo-banner repo-banner--error" role="alert">
          Story not found.
        </p>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <header className="board-page-header">
        <div>
          <h2 className="board-page-title">
            <Link href={`/repositories/${repository.id}/board`}>{repository.name}</Link> / Story #{story.id}
          </h2>
          <p className="meta-text">{story.title}</p>
        </div>
        <div className="board-page-header__status">
          <span className="meta-text">Board stream: {connectionState}</span>
        </div>
      </header>

      {connectionError ? (
        <p className="repo-banner repo-banner--error" role="alert">
          {connectionError}
        </p>
      ) : null}

      {actionError ? (
        <p className="repo-banner repo-banner--error" role="alert">
          {actionError}
        </p>
      ) : null}

      <section className="surface surface-card surface--default">
        <header className="surface-header">
          <h3>Story</h3>
          <p>{formatWorkItemStatusLabel(story.status)}</p>
        </header>

        <div className="board-detail__section board-detail__section--divider">
          <h5>Parent chain</h5>
          {parentChain.length === 0 ? (
            <p className="meta-text">None</p>
          ) : (
            <ol className="board-parent-chain">
              {parentChain.map(parent => (
                <li key={parent.id}>
                  <span className="board-pill">{parent.type}</span>
                  <span>
                    {parent.title} <span className="meta-text">#{parent.id}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="board-detail__section board-detail__section--divider">
          <h5>Actions</h5>
          <div className="board-action-row">
            {story.status === 'Draft' ? (
              <ActionButton tone="primary" onClick={() => void handleRequestBreakdown()} disabled={busy}>
                Request breakdown
              </ActionButton>
            ) : null}

            {story.status === 'BreakdownProposed' ? (
              <>
                <ActionButton tone="primary" onClick={() => void handleApproveBreakdown()} disabled={busy}>
                  Approve breakdown
                </ActionButton>
                <ActionButton tone="secondary" onClick={() => void handleRequestChanges()} disabled={busy}>
                  Request changes
                </ActionButton>
              </>
            ) : null}

            <ActionButton tone="secondary" onClick={() => void refreshAll()} disabled={busy}>
              Refresh
            </ActionButton>
          </div>
          {story.status === 'NeedsBreakdown' ? (
            <p className="meta-text">
              Waiting for an agent to propose a breakdown. Once proposed, review the plan here and approve to move tasks from Draft to Ready.
            </p>
          ) : null}
        </div>

        {story.status === 'BreakdownProposed' ? (
          <div className="board-detail__section board-detail__section--divider">
            <h5>Proposed plan</h5>
            {proposal ? (
              <>
                <p className="meta-text">
                  Proposal event #{proposal.eventId} · {new Date(proposal.createdAt).toLocaleString()}
                </p>
                <h6 className="meta-text">Proposed planned files</h6>
                {renderStringList(proposal.proposed.plannedFiles)}
                <h6 className="meta-text">Proposed tasks</h6>
                <ol className="board-detail__list">
                  {proposal.proposed.tasks.map((task, idx) => (
                    <li key={`${idx}-${task.title}`}>
                      <strong>{task.title}</strong>
                      {task.plannedFiles && task.plannedFiles.length > 0 ? (
                        <div className="meta-text">Files: {task.plannedFiles.join(', ')}</div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="meta-text">No breakdown proposal payload found yet. Try Refresh.</p>
            )}
          </div>
        ) : null}

        <div className="board-detail__section">
          <h5>Child tasks</h5>
          {childTasks.length === 0 ? (
            <p className="meta-text">None</p>
          ) : (
            <ol className="board-detail__list">
              {childTasks.map(task => (
                <li key={task.id}>
                  <span className="board-pill">{formatWorkItemStatusLabel(task.status)}</span>{' '}
                  <span>
                    {task.title} <span className="meta-text">#{task.id}</span>
                  </span>
                  {task.plannedFiles && task.plannedFiles.length > 0 ? (
                    <div className="meta-text">Planned files: {task.plannedFiles.join(', ')}</div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
