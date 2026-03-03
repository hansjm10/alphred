'use client';

import type { WorkItemStatus } from '@alphred/shared';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DashboardRepositoryState,
  DashboardStoryBreakdownProposalSnapshot,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';
import { ActionButton, ButtonLink } from '../../../../ui/primitives';
import type { BoardConnectionState, WorkItemActor } from '../../_shared/work-items-shared';
import {
  applyBoardEventToWorkItems,
  buildParentChain,
  fetchWorkItem,
  isRecord,
  moveWorkItemStatus,
  parseBoardEventSnapshot,
  parseJsonSafely,
  resolveApiErrorMessage,
  toWorkItemsById,
} from '../../_shared/work-items-shared';

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
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionSessionRef = useRef(0);

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

  const connect = (sessionId: number) => {
    if (connectionSessionRef.current !== sessionId) {
      return;
    }

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
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      const parsed = parseJsonSafely(event.data);
      if (isRecord(parsed) && typeof parsed.latestEventId === 'number') {
        // board_state indicates a high watermark, but we still resume from last delivered event id.
        setConnectionState('live');
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      setConnectionState('live');
    });

    eventSource.addEventListener('board_error', (event) => {
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      const parsed = parseJsonSafely(event.data);
      if (isRecord(parsed) && typeof parsed.message === 'string') {
        setConnectionError(parsed.message);
      } else {
        setConnectionError('Board stream error.');
      }
    });

    eventSource.addEventListener('board_event', (event) => {
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      const parsed = parseJsonSafely(event.data);
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
      if (connectionSessionRef.current !== sessionId) {
        eventSource.close();
        return;
      }
      setConnectionState('live');
    };

    eventSource.onerror = () => {
      if (connectionSessionRef.current !== sessionId) {
        eventSource.close();
        return;
      }
      setConnectionState('stale');
      setConnectionError('Connection lost. Reconnecting…');
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current !== null) {
        globalThis.clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = globalThis.setTimeout(() => {
        connect(sessionId);
      }, 1000);
    };
  };

  useEffect(() => {
    const sessionId = connectionSessionRef.current + 1;
    connectionSessionRef.current = sessionId;
    connect(sessionId);
    return () => {
      if (connectionSessionRef.current === sessionId) {
        connectionSessionRef.current = sessionId + 1;
      }
      if (reconnectTimeoutRef.current !== null) {
        globalThis.clearTimeout(reconnectTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [repository.id, storyId]);

  const refreshAll = async (options?: { bannerMessage?: string | null }) => {
    setBusy(true);
    setActionError(options?.bannerMessage ?? null);
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
      errorPrefix: 'Unable to move story status',
    });
    if (moveResult.ok) {
      setWorkItemsById(previous => ({ ...previous, [moveResult.workItem.id]: moveResult.workItem }));
    } else if (moveResult.status === 409) {
      await refreshAll({ bannerMessage: `Revision conflict: ${moveResult.message}` });
    } else {
      setActionError(moveResult.message);
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
      errorPrefix: 'Unable to move story status',
    });
    if (moveResult.ok) {
      setProposal(null);
      setWorkItemsById(previous => ({ ...previous, [moveResult.workItem.id]: moveResult.workItem }));
    } else if (moveResult.status === 409) {
      await refreshAll({ bannerMessage: `Revision conflict: ${moveResult.message}` });
    } else {
      setActionError(moveResult.message);
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
    } else if (approveResult.status === 409) {
      await refreshAll({ bannerMessage: `Revision conflict: ${approveResult.message}` });
    } else {
      setActionError(approveResult.message);
    }

    setBusy(false);
  };

  if (story?.type !== 'story') {
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
          <div className="board-page-header__actions">
            <ButtonLink href={`/repositories/${repository.id}/stories`} tone="secondary">
              Stories
            </ButtonLink>
            <span className="meta-text">Board stream: {connectionState}</span>
          </div>
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
