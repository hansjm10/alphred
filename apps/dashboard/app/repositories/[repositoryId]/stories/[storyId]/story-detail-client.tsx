'use client';

import type { WorkItemStatus } from '@alphred/shared';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DashboardRepositoryState,
  DashboardRunStoryWorkflowResult,
  DashboardStoryBreakdownProposalSnapshot,
  DashboardStoryWorkspaceSnapshot,
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
  runStoryWorkflow,
  toWorkItemsById,
} from '../../_shared/work-items-shared';

type ActionMessage = Readonly<{
  tone: 'success' | 'error';
  message: string;
}>;

type WorkspaceAction = 'create' | 'reconcile' | 'cleanup' | 'recreate';

type StoryDetailSnapshot = Readonly<{
  repository: DashboardRepositoryState;
  workItemsById: Readonly<Record<number, DashboardWorkItemSnapshot>>;
  proposal: DashboardStoryBreakdownProposalSnapshot | null;
  workspace: DashboardStoryWorkspaceSnapshot | null;
}>;

const workspaceActionSuccessMessage: Record<WorkspaceAction, string> = {
  create: 'Workspace created.',
  reconcile: 'Workspace reconciled.',
  cleanup: 'Workspace cleanup completed.',
  recreate: 'Workspace recreated.',
};

const workspaceActionPathSegment: Record<WorkspaceAction, string> = {
  create: 'create-workspace',
  reconcile: 'reconcile-workspace',
  cleanup: 'cleanup-workspace',
  recreate: 'recreate-workspace',
};

async function fetchRepository(params: { repositoryId: number }): Promise<DashboardRepositoryState> {
  const response = await fetch(`/api/dashboard/repositories/${params.repositoryId}`, { method: 'GET' });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh repository'));
  }

  if (!isRecord(payload) || !isRecord(payload.repository)) {
    throw new Error('Unable to refresh repository (malformed response).');
  }

  return payload.repository as DashboardRepositoryState;
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

async function fetchBreakdownProposal(params: {
  repositoryId: number;
  storyId: number;
}): Promise<DashboardStoryBreakdownProposalSnapshot | null> {
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

async function fetchStoryWorkspace(params: {
  repositoryId: number;
  storyId: number;
}): Promise<DashboardStoryWorkspaceSnapshot | null> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/workspace?repositoryId=${params.repositoryId}`, {
    method: 'GET',
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh story workspace'));
  }

  if (!isRecord(payload)) {
    throw new Error('Unable to refresh story workspace (malformed response).');
  }

  return (payload.workspace ?? null) as DashboardStoryWorkspaceSnapshot | null;
}

async function runWorkspaceAction(params: {
  repositoryId: number;
  storyId: number;
  action: WorkspaceAction;
}): Promise<DashboardStoryWorkspaceSnapshot> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/${workspaceActionPathSegment[params.action]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
    }),
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to update story workspace'));
  }

  if (!isRecord(payload) || !isRecord(payload.workspace)) {
    throw new Error('Unable to update story workspace (malformed response).');
  }

  return payload.workspace as DashboardStoryWorkspaceSnapshot;
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

function formatWorkspaceStatusLabel(status: DashboardStoryWorkspaceSnapshot['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'stale':
      return 'Stale';
    case 'removed':
      return 'Removed';
    default:
      return status;
  }
}

function formatWorkspaceStatusReasonLabel(
  statusReason: DashboardStoryWorkspaceSnapshot['statusReason'],
): string {
  switch (statusReason) {
    case null:
      return 'None';
    case 'missing_path':
      return 'Missing path';
    case 'worktree_not_registered':
      return 'Worktree not registered';
    case 'branch_mismatch':
      return 'Branch mismatch';
    case 'repository_clone_missing':
      return 'Repository clone missing';
    case 'reconcile_failed':
      return 'Reconcile failed';
    case 'removed_state_drift':
      return 'Removed state drift';
    case 'cleanup_requested':
      return 'Cleanup requested';
    default:
      return statusReason;
  }
}

function formatTimestamp(value: string | null): string {
  if (value === null) {
    return 'None';
  }

  return new Date(value).toLocaleString();
}

function mergeStoryWorkflowWorkItems(
  previous: Readonly<Record<number, DashboardWorkItemSnapshot>>,
  result: DashboardRunStoryWorkflowResult,
): Record<number, DashboardWorkItemSnapshot> {
  const next: Record<number, DashboardWorkItemSnapshot> = { ...previous };
  next[result.story.id] = result.story;
  for (const task of result.updatedTasks) {
    next[task.id] = task;
  }
  return next;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resolveVisibleWorkspaceActions(workspace: DashboardStoryWorkspaceSnapshot | null): readonly WorkspaceAction[] {
  if (workspace === null) {
    return ['create'];
  }

  if (workspace.status === 'removed') {
    return ['recreate'];
  }

  return ['reconcile', 'cleanup'];
}

export function StoryDetailPageContent(props: Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  storyId: number;
  initialLatestEventId: number;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
  initialProposal: DashboardStoryBreakdownProposalSnapshot | null;
  initialWorkspace: DashboardStoryWorkspaceSnapshot | null;
}>) {
  const { repository, actor, storyId, initialLatestEventId, initialWorkItems, initialProposal, initialWorkspace } = props;

  const [repositoryState, setRepositoryState] = useState(repository);
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [proposal, setProposal] = useState<DashboardStoryBreakdownProposalSnapshot | null>(initialProposal);
  const [workspace, setWorkspace] = useState<DashboardStoryWorkspaceSnapshot | null>(initialWorkspace);
  const [connectionState, setConnectionState] = useState<BoardConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
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

  const visibleWorkspaceActions = useMemo(() => resolveVisibleWorkspaceActions(workspace), [workspace]);

  const applySnapshot = (snapshot: StoryDetailSnapshot) => {
    setRepositoryState(snapshot.repository);
    setWorkItemsById(snapshot.workItemsById);
    setProposal(snapshot.proposal);
    setWorkspace(snapshot.workspace);
  };

  const loadLatestSnapshot = async (): Promise<StoryDetailSnapshot> => {
    const [latestRepository, workItems, latestProposal, latestStory, latestWorkspace] = await Promise.all([
      fetchRepository({ repositoryId: repository.id }),
      fetchRepositoryWorkItems({ repositoryId: repository.id }),
      fetchBreakdownProposal({ repositoryId: repository.id, storyId }),
      fetchWorkItem({ repositoryId: repository.id, workItemId: storyId }),
      fetchStoryWorkspace({ repositoryId: repository.id, storyId }),
    ]);

    const nextWorkItemsById: Record<number, DashboardWorkItemSnapshot> = {
      ...toWorkItemsById(workItems),
    };
    nextWorkItemsById[latestStory.id] = latestStory;

    return {
      repository: latestRepository,
      workItemsById: nextWorkItemsById,
      proposal: latestProposal,
      workspace: latestWorkspace,
    };
  };

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

    eventSource.addEventListener('board_state', event => {
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      const parsed = parseJsonSafely(event.data);
      if (isRecord(parsed) && typeof parsed.latestEventId === 'number') {
        setConnectionState('live');
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      if (connectionSessionRef.current !== sessionId) {
        return;
      }
      setConnectionState('live');
    });

    eventSource.addEventListener('board_error', event => {
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

    eventSource.addEventListener('board_event', event => {
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

  const refreshAll = async (options?: { bannerMessage?: ActionMessage | null }) => {
    setBusy(true);
    setActionMessage(options?.bannerMessage ?? null);
    try {
      const latest = await loadLatestSnapshot();
      applySnapshot(latest);
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: toErrorMessage(error, 'Unable to refresh story detail.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRequestBreakdown = async () => {
    if (!story) return;
    setBusy(true);
    setActionMessage(null);
    const workflowResult = await runStoryWorkflow({
      repositoryId: repository.id,
      storyId: story.id,
      expectedRevision: story.revision,
      actor,
      generateOnly: true,
      errorPrefix: 'Unable to run story workflow',
    });
    if (workflowResult.ok) {
      setWorkItemsById(previous => mergeStoryWorkflowWorkItems(previous, workflowResult.result));
    } else if (workflowResult.status === 409) {
      await refreshAll({ bannerMessage: { tone: 'error', message: `Revision conflict: ${workflowResult.message}` } });
    } else {
      setActionMessage({ tone: 'error', message: workflowResult.message });
    }
    setBusy(false);
  };

  const handleRequestChanges = async () => {
    if (!story) return;
    setBusy(true);
    setActionMessage(null);
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
      await refreshAll({ bannerMessage: { tone: 'error', message: `Revision conflict: ${moveResult.message}` } });
    } else {
      setActionMessage({ tone: 'error', message: moveResult.message });
    }
    setBusy(false);
  };

  const handleApproveBreakdown = async () => {
    if (!story) return;
    setBusy(true);
    setActionMessage(null);
    const workflowResult = await runStoryWorkflow({
      repositoryId: repository.id,
      storyId,
      expectedRevision: story.revision,
      actor,
      approveOnly: true,
      errorPrefix: 'Unable to run story workflow',
    });

    if (workflowResult.ok) {
      setProposal(null);
      setWorkItemsById(previous => mergeStoryWorkflowWorkItems(previous, workflowResult.result));
    } else if (workflowResult.status === 409) {
      await refreshAll({ bannerMessage: { tone: 'error', message: `Revision conflict: ${workflowResult.message}` } });
    } else {
      setActionMessage({ tone: 'error', message: workflowResult.message });
    }

    setBusy(false);
  };

  const handleWorkspaceAction = async (action: WorkspaceAction) => {
    if (!story) {
      return;
    }

    setBusy(true);
    setActionMessage(null);

    try {
      const nextWorkspace = await runWorkspaceAction({
        repositoryId: repository.id,
        storyId: story.id,
        action,
      });
      setWorkspace(nextWorkspace);

      const successMessage = workspaceActionSuccessMessage[action];
      try {
        const latest = await loadLatestSnapshot();
        applySnapshot(latest);
        setActionMessage({ tone: 'success', message: successMessage });
      } catch (refreshError) {
        setActionMessage({
          tone: 'success',
          message: `${successMessage} Unable to refresh story detail: ${toErrorMessage(
            refreshError,
            'Unable to refresh story detail.',
          )}`,
        });
      }
    } catch (error) {
      setActionMessage({
        tone: 'error',
        message: toErrorMessage(error, 'Unable to update story workspace.'),
      });
    } finally {
      setBusy(false);
    }
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

  const launchRunHref = `/runs?repository=${encodeURIComponent(repositoryState.name)}&launchWorkItemId=${story.id}`;

  return (
    <div className="page-stack">
      <header className="board-page-header">
        <div>
          <h2 className="board-page-title">
            <Link href={`/repositories/${repository.id}/board`}>{repositoryState.name}</Link> / Story #{story.id}
          </h2>
          <p className="meta-text">{story.title}</p>
        </div>
        <div className="board-page-header__status">
          <div className="board-page-header__actions">
            <ButtonLink href={`/repositories/${repository.id}/stories`} tone="secondary">
              Stories
            </ButtonLink>
            <ButtonLink href={launchRunHref} tone="secondary">
              Launch run for this story
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

      {actionMessage ? (
        actionMessage.tone === 'error' ? (
          <p className="repo-banner repo-banner--error" role="alert">
            {actionMessage.message}
          </p>
        ) : (
          <output className="repo-banner repo-banner--success" aria-live="polite">
            {actionMessage.message}
          </output>
        )
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
          <h5>Workspace</h5>
          {workspace ? (
            <>
              <ul className="board-detail__list">
                <li>Status: {formatWorkspaceStatusLabel(workspace.status)}</li>
                <li>Status reason: {formatWorkspaceStatusReasonLabel(workspace.statusReason)}</li>
                <li>Path: {workspace.path}</li>
                <li>Branch: {workspace.branch}</li>
                <li>Base branch: {workspace.baseBranch}</li>
                <li>Base commit: {workspace.baseCommitHash ?? 'None'}</li>
                <li>Created: {formatTimestamp(workspace.createdAt)}</li>
                <li>Updated: {formatTimestamp(workspace.updatedAt)}</li>
                <li>Last reconciled: {formatTimestamp(workspace.lastReconciledAt)}</li>
                <li>Removed: {formatTimestamp(workspace.removedAt)}</li>
              </ul>
            </>
          ) : (
            <p className="meta-text">No story workspace exists yet.</p>
          )}
          <h6 className="meta-text">Repository</h6>
          <ul className="board-detail__list">
            <li>Clone status: {repositoryState.cloneStatus}</li>
            <li>Local path: {repositoryState.localPath ?? 'None'}</li>
          </ul>
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

            {visibleWorkspaceActions.map(action => (
              <ActionButton
                key={action}
                tone={action === 'create' || action === 'recreate' ? 'primary' : 'secondary'}
                onClick={() => void handleWorkspaceAction(action)}
                disabled={busy}
              >
                {action === 'create'
                  ? 'Create workspace'
                  : action === 'reconcile'
                    ? 'Reconcile workspace'
                    : action === 'cleanup'
                      ? 'Cleanup workspace'
                      : 'Recreate workspace'}
              </ActionButton>
            ))}

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
