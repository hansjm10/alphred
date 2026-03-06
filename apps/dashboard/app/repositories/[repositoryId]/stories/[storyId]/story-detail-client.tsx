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
  runStoryWorkflow,
  parseBoardEventSnapshot,
  parseJsonSafely,
  resolveApiErrorMessage,
  toWorkItemsById,
} from '../../_shared/work-items-shared';

type StoryWorkspaceAction = 'create-workspace' | 'reconcile-workspace' | 'cleanup-workspace' | 'recreate-workspace';

type StoryWorkspaceActionResult = {
  workspace: DashboardStoryWorkspaceSnapshot;
  created?: boolean;
};

const repositoryProviders = new Set<DashboardRepositoryState['provider']>(['github', 'azure-devops']);
const repositoryCloneStatuses = new Set<DashboardRepositoryState['cloneStatus']>(['pending', 'cloned', 'error']);
const storyWorkspaceStatuses = new Set<DashboardStoryWorkspaceSnapshot['status']>(['active', 'stale', 'removed']);
const storyWorkspaceStatusReasons = new Set<NonNullable<DashboardStoryWorkspaceSnapshot['statusReason']>>([
  'missing_path',
  'worktree_not_registered',
  'branch_mismatch',
  'repository_clone_missing',
  'reconcile_failed',
  'cleanup_requested',
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableStoryWorkspaceStatusReason(
  value: unknown,
): value is DashboardStoryWorkspaceSnapshot['statusReason'] {
  return value === null || (typeof value === 'string' && storyWorkspaceStatusReasons.has(value as NonNullable<
    DashboardStoryWorkspaceSnapshot['statusReason']
  >));
}

function isRepositoryState(value: unknown): value is DashboardRepositoryState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'number'
    && typeof value.name === 'string'
    && typeof value.provider === 'string'
    && repositoryProviders.has(value.provider as DashboardRepositoryState['provider'])
    && typeof value.remoteRef === 'string'
    && typeof value.remoteUrl === 'string'
    && typeof value.defaultBranch === 'string'
    && isNullableString(value.branchTemplate)
    && typeof value.cloneStatus === 'string'
    && repositoryCloneStatuses.has(value.cloneStatus as DashboardRepositoryState['cloneStatus'])
    && isNullableString(value.localPath)
    && isNullableString(value.archivedAt)
  );
}

function isStoryWorkspaceSnapshot(value: unknown): value is DashboardStoryWorkspaceSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'number'
    && typeof value.repositoryId === 'number'
    && typeof value.storyId === 'number'
    && typeof value.path === 'string'
    && typeof value.branch === 'string'
    && typeof value.baseBranch === 'string'
    && isNullableString(value.baseCommitHash)
    && typeof value.status === 'string'
    && storyWorkspaceStatuses.has(value.status as DashboardStoryWorkspaceSnapshot['status'])
    && isNullableStoryWorkspaceStatusReason(value.statusReason)
    && isNullableString(value.lastReconciledAt)
    && isNullableString(value.removedAt)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
  );
}

async function fetchRepository(params: { repositoryId: number }): Promise<DashboardRepositoryState> {
  const response = await fetch(`/api/dashboard/repositories/${params.repositoryId}`, { method: 'GET' });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh repository'));
  }

  if (!isRecord(payload) || !isRepositoryState(payload.repository)) {
    throw new Error('Unable to refresh repository (malformed response).');
  }

  return payload.repository;
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

async function runStoryWorkspaceAction(params: {
  repositoryId: number;
  storyId: number;
  action: StoryWorkspaceAction;
  errorPrefix: string;
}): Promise<StoryWorkspaceActionResult> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/${params.action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
    }),
  });
  const payload = parseJsonSafely(await response.text());

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, params.errorPrefix));
  }

  if (!isRecord(payload) || !isStoryWorkspaceSnapshot(payload.workspace)) {
    throw new Error(`${params.errorPrefix} (malformed response).`);
  }

  return {
    workspace: payload.workspace,
    created: typeof payload.created === 'boolean' ? payload.created : undefined,
  };
}

async function refreshStoryWorkspace(params: {
  repositoryId: number;
  storyId: number;
}): Promise<DashboardStoryWorkspaceSnapshot | null> {
  const response = await fetch(`/api/dashboard/work-items/${params.storyId}/actions/reconcile-workspace`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      repositoryId: params.repositoryId,
    }),
  });
  const payload = parseJsonSafely(await response.text());

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh story workspace'));
  }

  if (!isRecord(payload) || !isStoryWorkspaceSnapshot(payload.workspace)) {
    throw new Error('Unable to refresh story workspace (malformed response).');
  }

  return payload.workspace;
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

function formatStoryWorkspaceStatusLabel(status: DashboardStoryWorkspaceSnapshot['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'stale':
      return 'Stale';
    case 'removed':
      return 'Removed';
  }
}

function formatStoryWorkspaceReason(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'missing_path':
      return 'Workspace directory is missing from disk.';
    case 'worktree_not_registered':
      return 'Git no longer reports this directory as a registered worktree.';
    case 'branch_mismatch':
      return 'Git reports a different branch for this worktree than the persisted story branch.';
    case 'repository_clone_missing':
      return 'The repository clone is unavailable, so the workspace cannot be fully reconciled.';
    case 'reconcile_failed':
      return 'Workspace reconciliation could not inspect the repository state.';
    case 'cleanup_requested':
      return 'The workspace was explicitly cleaned up.';
    default:
      return reason;
  }
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Unavailable';
}

function formatArchivedRunLaunchMessage(repositoryName: string): string {
  return `Repository "${repositoryName}" is archived. Restore it before launching runs.`;
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

  const [repositoryState, setRepositoryState] = useState<DashboardRepositoryState>(repository);
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [proposal, setProposal] = useState<DashboardStoryBreakdownProposalSnapshot | null>(initialProposal);
  const [workspace, setWorkspace] = useState<DashboardStoryWorkspaceSnapshot | null>(initialWorkspace);
  const [connectionState, setConnectionState] = useState<BoardConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
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

  const workspaceCreateBlockedReason = useMemo(() => {
    if (!story || story.status !== 'Done') {
      if (repositoryState.archivedAt !== null) {
        return 'Repository is archived. Restore it before creating or recreating a story workspace.';
      }
      return null;
    }

    return repositoryState.archivedAt !== null
      ? 'Repository is archived and the story is already Done. Only reconciliation and cleanup remain available.'
      : 'Story is Done. Clean up the existing workspace instead of creating or recreating a new one.';
  }, [repositoryState.archivedAt, story]);

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
      `/api/dashboard/repositories/${repositoryState.id}/board/events?transport=sse&lastEventId=${lastEventId}`,
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('board_state', (event) => {
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

      setWorkItemsById(previous => applyBoardEventToWorkItems(previous, repositoryState.id, snapshot));

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
  }, [repositoryState.id, storyId]);

  const refreshAll = async (options?: { bannerMessage?: string | null }) => {
    setBusy(true);
    setActionError(options?.bannerMessage ?? null);
    setActionNotice(null);
    try {
      const repositoryRefresh = fetchRepository({
        repositoryId: repositoryState.id,
      });
      const workspaceRefresh = refreshStoryWorkspace({
        repositoryId: repositoryState.id,
        storyId,
      });

      const [latestRepository, workItems, latestProposal, latestStory, latestWorkspace] = await Promise.all([
        repositoryRefresh,
        fetchRepositoryWorkItems({ repositoryId: repositoryState.id }),
        fetchBreakdownProposal({ repositoryId: repositoryState.id, storyId }),
        fetchWorkItem({ repositoryId: repositoryState.id, workItemId: storyId }),
        workspaceRefresh,
      ]);
      setRepositoryState(latestRepository);
      setWorkItemsById(toWorkItemsById(workItems));
      setProposal(latestProposal);
      setWorkspace(latestWorkspace);
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
    setActionNotice(null);
    const workflowResult = await runStoryWorkflow({
      repositoryId: repositoryState.id,
      storyId: story.id,
      expectedRevision: story.revision,
      actor,
      generateOnly: true,
      errorPrefix: 'Unable to run story workflow',
    });
    if (workflowResult.ok) {
      setWorkItemsById(previous => mergeStoryWorkflowWorkItems(previous, workflowResult.result));
    } else if (workflowResult.status === 409) {
      await refreshAll({ bannerMessage: `Revision conflict: ${workflowResult.message}` });
    } else {
      setActionError(workflowResult.message);
    }
    setBusy(false);
  };

  const handleRequestChanges = async () => {
    if (!story) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    const moveResult = await moveWorkItemStatus({
      repositoryId: repositoryState.id,
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
    setActionNotice(null);
    const workflowResult = await runStoryWorkflow({
      repositoryId: repositoryState.id,
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
      await refreshAll({ bannerMessage: `Revision conflict: ${workflowResult.message}` });
    } else {
      setActionError(workflowResult.message);
    }

    setBusy(false);
  };

  const handleCreateStoryWorkspace = async () => {
    if (!story) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await runStoryWorkspaceAction({
        repositoryId: repositoryState.id,
        storyId: story.id,
        action: 'create-workspace',
        errorPrefix: 'Unable to create story workspace',
      });
      setWorkspace(result.workspace);
      setActionNotice(
        result.created === false
          ? `Story workspace already exists on branch ${result.workspace.branch}.`
          : `Story workspace ready on branch ${result.workspace.branch}.`,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create story workspace.');
    } finally {
      setBusy(false);
    }
  };

  const handleReconcileStoryWorkspace = async () => {
    if (!story || !workspace) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await runStoryWorkspaceAction({
        repositoryId: repositoryState.id,
        storyId: story.id,
        action: 'reconcile-workspace',
        errorPrefix: 'Unable to reconcile story workspace',
      });
      setWorkspace(result.workspace);
      const reason = formatStoryWorkspaceReason(result.workspace.statusReason);
      setActionNotice(
        result.workspace.status === 'active'
          ? 'Story workspace is active and matches the repository state.'
          : `Story workspace is ${formatStoryWorkspaceStatusLabel(result.workspace.status).toLowerCase()}${reason ? `: ${reason}` : '.'}`,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to reconcile story workspace.');
    } finally {
      setBusy(false);
    }
  };

  const handleCleanupStoryWorkspace = async () => {
    if (!story || !workspace) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await runStoryWorkspaceAction({
        repositoryId: repositoryState.id,
        storyId: story.id,
        action: 'cleanup-workspace',
        errorPrefix: 'Unable to clean up story workspace',
      });
      setWorkspace(result.workspace);
      setActionNotice('Story workspace cleaned up.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to clean up story workspace.');
    } finally {
      setBusy(false);
    }
  };

  const handleRecreateStoryWorkspace = async () => {
    if (!story || !workspace) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await runStoryWorkspaceAction({
        repositoryId: repositoryState.id,
        storyId: story.id,
        action: 'recreate-workspace',
        errorPrefix: 'Unable to recreate story workspace',
      });
      setWorkspace(result.workspace);
      setActionNotice(`Story workspace recreated on branch ${result.workspace.branch}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to recreate story workspace.');
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
  const launchRunBlockedReason = repositoryState.archivedAt === null
    ? null
    : formatArchivedRunLaunchMessage(repositoryState.name);
  const workspaceReason = formatStoryWorkspaceReason(workspace?.statusReason ?? null);
  const canCreateOrRecreateWorkspace = workspaceCreateBlockedReason === null;

  return (
    <div className="page-stack">
      <header className="board-page-header">
        <div>
          <h2 className="board-page-title">
            <Link href={`/repositories/${repositoryState.id}/board`}>{repositoryState.name}</Link> / Story #{story.id}
          </h2>
          <p className="meta-text">{story.title}</p>
        </div>
        <div className="board-page-header__status">
          <div className="board-page-header__actions">
            <ButtonLink href={`/repositories/${repositoryState.id}/stories`} tone="secondary">
              Stories
            </ButtonLink>
            {launchRunBlockedReason === null ? (
              <ButtonLink href={launchRunHref} tone="secondary">
                Launch run for this story
              </ButtonLink>
            ) : (
              <span className="meta-text">{launchRunBlockedReason}</span>
            )}
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

      {actionNotice ? (
        <output className="repo-banner repo-banner--success" aria-live="polite">
          {actionNotice}
        </output>
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

        <div className="board-detail__section board-detail__section--divider">
          <h5>Story workspace</h5>
          {workspace ? (
            <>
              <p className="meta-text">
                Status: <span className="board-pill">{formatStoryWorkspaceStatusLabel(workspace.status)}</span>
              </p>
              <p className="meta-text">
                Branch: <code>{workspace.branch}</code> · Base: <code>{workspace.baseBranch}</code>
              </p>
              <p className="meta-text">
                Path: <code>{workspace.path}</code>
              </p>
              <p className="meta-text">Last reconciled: {formatTimestamp(workspace.lastReconciledAt)}</p>
              {workspace.removedAt ? (
                <p className="meta-text">Removed at: {formatTimestamp(workspace.removedAt)}</p>
              ) : null}
              {workspaceReason ? <p className="meta-text">{workspaceReason}</p> : null}
            </>
          ) : (
            <p className="meta-text">No workspace created yet.</p>
          )}

          <div className="board-action-row">
            {workspace === null && canCreateOrRecreateWorkspace ? (
              <ActionButton tone="secondary" onClick={() => void handleCreateStoryWorkspace()} disabled={busy}>
                Create story workspace
              </ActionButton>
            ) : null}

            {workspace !== null && workspace.status !== 'removed' ? (
              <ActionButton tone="secondary" onClick={() => void handleReconcileStoryWorkspace()} disabled={busy}>
                Reconcile workspace
              </ActionButton>
            ) : null}

            {workspace !== null && workspace.status !== 'removed' ? (
              <ActionButton tone="secondary" onClick={() => void handleCleanupStoryWorkspace()} disabled={busy}>
                Cleanup workspace
              </ActionButton>
            ) : null}

            {workspace !== null && canCreateOrRecreateWorkspace ? (
              <ActionButton tone="secondary" onClick={() => void handleRecreateStoryWorkspace()} disabled={busy}>
                Recreate workspace
              </ActionButton>
            ) : null}
          </div>

          {workspaceCreateBlockedReason ? <p className="meta-text">{workspaceCreateBlockedReason}</p> : null}
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
