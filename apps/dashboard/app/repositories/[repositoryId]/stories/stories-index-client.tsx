'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkItemStatus } from '@alphred/shared';
import type {
  DashboardRepositoryState,
  DashboardRunStoryWorkflowResult,
  DashboardWorkItemSnapshot,
} from '@dashboard/server/dashboard-contracts';
import { ActionButton, ButtonLink } from '../../../ui/primitives';
import {
  isRecord,
  parseJsonSafely,
  resolveApiErrorMessage,
  runStoryWorkflow,
  toWorkItemsById,
  type WorkItemActor,
} from '../_shared/work-items-shared';

function formatWorkItemStatusLabel(status: WorkItemStatus): string {
  switch (status) {
    case 'NeedsBreakdown':
      return 'Needs breakdown';
    case 'BreakdownProposed':
      return 'Breakdown proposed';
    default:
      return status;
  }
}

function canRunStoryWorkflow(status: WorkItemStatus): boolean {
  return status === 'Draft' || status === 'NeedsBreakdown' || status === 'BreakdownProposed' || status === 'Approved';
}

async function refreshRepositoryWorkItemsAfterConflict(params: {
  repositoryId: number;
}): Promise<{ ok: true; workItems: DashboardWorkItemSnapshot[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`/api/dashboard/repositories/${params.repositoryId}/work-items`, { method: 'GET' });
    const payload = parseJsonSafely(await response.text());

    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, 'Unable to refresh work items'));
    }

    if (!isRecord(payload) || !Array.isArray(payload.workItems)) {
      throw new Error('Unable to refresh work items (malformed response).');
    }

    return { ok: true, workItems: payload.workItems as DashboardWorkItemSnapshot[] };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveWorkflowFeedback(params: {
  storyId: number;
  result: DashboardRunStoryWorkflowResult;
}): { notice?: string; error?: string } {
  const { storyId, result } = params;
  const startStep = result.steps.find(step => step.step === 'start_ready_tasks');
  if (startStep?.outcome === 'partial_failure') {
    return { error: startStep.message };
  }

  if (result.startedTasks.length > 0) {
    return {
      notice: `Story #${storyId} workflow ran and ${result.startedTasks.length} task${result.startedTasks.length === 1 ? '' : 's'} started.`,
    };
  }

  const blockedStep = result.steps.find(step => step.step === 'generate_breakdown' && step.outcome === 'blocked');
  if (blockedStep) {
    return { notice: blockedStep.message };
  }

  return { notice: `Story #${storyId} workflow completed with no task starts.` };
}

type StoryWorkflowRunResult = Awaited<ReturnType<typeof runStoryWorkflow>>;

type StoryWorkflowDisplayState = Readonly<{
  workItems: readonly DashboardWorkItemSnapshot[];
  workItemsMode: 'replace' | 'upsert';
  error: string | null;
  notice: string | null;
}>;

function resolveSuccessfulWorkflowRun(params: {
  storyId: number;
  runResult: Extract<StoryWorkflowRunResult, { ok: true }>;
}): StoryWorkflowDisplayState {
  const workflowFeedback = resolveWorkflowFeedback({
    storyId: params.storyId,
    result: params.runResult.result,
  });

  return {
    workItems: [params.runResult.result.story, ...params.runResult.result.updatedTasks],
    workItemsMode: 'upsert',
    error: workflowFeedback.error ?? null,
    notice: workflowFeedback.error ? null : (workflowFeedback.notice ?? null),
  };
}

async function resolveFailedWorkflowRun(params: {
  repositoryId: number;
  runResult: Extract<StoryWorkflowRunResult, { ok: false }>;
}): Promise<StoryWorkflowDisplayState> {
  if (params.runResult.status !== 409) {
    return {
      workItems: [],
      workItemsMode: 'upsert',
      error: params.runResult.message,
      notice: null,
    };
  }

  const refreshedWorkItemsResult = await refreshRepositoryWorkItemsAfterConflict({
    repositoryId: params.repositoryId,
  });
  if (!refreshedWorkItemsResult.ok) {
    return {
      workItems: [],
      workItemsMode: 'upsert',
      error: refreshedWorkItemsResult.message,
      notice: null,
    };
  }

  return {
    workItems: refreshedWorkItemsResult.workItems,
    workItemsMode: 'replace',
    error: params.runResult.message,
    notice: null,
  };
}

async function runStoryWorkflowAndResolveDisplayState(params: {
  repositoryId: number;
  storyId: number;
  expectedRevision: number;
  actor: WorkItemActor;
}): Promise<StoryWorkflowDisplayState> {
  const runResult = await runStoryWorkflow({
    repositoryId: params.repositoryId,
    storyId: params.storyId,
    expectedRevision: params.expectedRevision,
    actor: params.actor,
    errorPrefix: `Unable to run story workflow for story #${params.storyId}`,
  });

  if (runResult.ok) {
    return resolveSuccessfulWorkflowRun({
      storyId: params.storyId,
      runResult,
    });
  }

  return resolveFailedWorkflowRun({
    repositoryId: params.repositoryId,
    runResult,
  });
}

export function StoriesIndexPageContent(props: Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
}>) {
  const { repository, actor, initialWorkItems } = props;
  const workflowRequestSequenceRef = useRef(0);
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [runningStoryId, setRunningStoryId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    workflowRequestSequenceRef.current += 1;
    setWorkItemsById(toWorkItemsById(initialWorkItems));
    setRunningStoryId(null);
    setActionError(null);
    setActionNotice(null);
  }, [repository.id, initialWorkItems]);

  const allWorkItems = useMemo(() => Object.values(workItemsById), [workItemsById]);
  const stories = useMemo(
    () =>
      allWorkItems
        .filter(item => item.type === 'story')
        .sort((a, b) => b.id - a.id),
    [allWorkItems],
  );
  const taskCountByStoryId = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of allWorkItems) {
      if (item.type !== 'task' || item.parentId === null) {
        continue;
      }
      counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
    }
    return counts;
  }, [allWorkItems]);

  const upsertWorkItems = (...items: readonly DashboardWorkItemSnapshot[]) => {
    setWorkItemsById(previous => {
      const next: Record<number, DashboardWorkItemSnapshot> = { ...previous };
      for (const item of items) {
        next[item.id] = item;
      }
      return next;
    });
  };

  const replaceWorkItems = (items: readonly DashboardWorkItemSnapshot[]) => {
    setWorkItemsById(toWorkItemsById(items));
  };

  const handleRunStoryWorkflow = async (story: DashboardWorkItemSnapshot) => {
    if (runningStoryId !== null) {
      return;
    }

    const requestSequence = workflowRequestSequenceRef.current + 1;
    workflowRequestSequenceRef.current = requestSequence;
    setRunningStoryId(story.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const displayState = await runStoryWorkflowAndResolveDisplayState({
        repositoryId: repository.id,
        storyId: story.id,
        expectedRevision: story.revision,
        actor,
      });
      if (workflowRequestSequenceRef.current !== requestSequence) {
        return;
      }
      if (displayState.workItemsMode === 'replace') {
        replaceWorkItems(displayState.workItems);
      } else if (displayState.workItems.length > 0) {
        upsertWorkItems(...displayState.workItems);
      }
      setActionError(displayState.error);
      setActionNotice(displayState.notice);
    } catch (error) {
      if (workflowRequestSequenceRef.current !== requestSequence) {
        return;
      }
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (workflowRequestSequenceRef.current === requestSequence) {
        setRunningStoryId(null);
      }
    }
  };

  return (
    <div className="page-stack">
      <header className="board-page-header">
        <div>
          <h2 className="board-page-title">
            <Link href={`/repositories/${repository.id}/board`}>{repository.name}</Link> / Stories
          </h2>
          <p className="meta-text">Stories tracked for this repository.</p>
        </div>
        <div className="board-page-header__status">
          <div className="board-page-header__actions">
            <ButtonLink href={`/repositories/${repository.id}/board`} tone="secondary">
              Board
            </ButtonLink>
          </div>
        </div>
      </header>

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
          <h3>Stories</h3>
          <p>{stories.length}</p>
        </header>

        <div className="board-detail__section">
          {stories.length === 0 ? (
            <p className="meta-text">None</p>
          ) : (
            <ol className="stories-list">
              {stories.map(story => (
                <li key={story.id} className="stories-list__item">
                  <div className="stories-list__content">
                    <div className="stories-list__meta">
                      <span className="board-pill">#{story.id}</span>
                      <span className="board-pill">{formatWorkItemStatusLabel(story.status)}</span>
                      <span className="meta-text">{taskCountByStoryId.get(story.id) ?? 0} tasks</span>
                    </div>
                    <Link href={`/repositories/${repository.id}/stories/${story.id}`}>{story.title}</Link>
                  </div>
                  <div className="stories-list__actions">
                    {canRunStoryWorkflow(story.status) ? (
                      <ActionButton
                        tone="primary"
                        onClick={() => void handleRunStoryWorkflow(story)}
                        disabled={runningStoryId !== null}
                        aria-disabled={runningStoryId !== null}
                      >
                        {runningStoryId === story.id ? 'Running…' : 'Run workflow'}
                      </ActionButton>
                    ) : null}
                    <ButtonLink href={`/repositories/${repository.id}/stories/${story.id}`} tone="secondary">
                      Open
                    </ButtonLink>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
