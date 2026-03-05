'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { WorkItemStatus } from '@alphred/shared';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import { ActionButton, ButtonLink } from '../../../ui/primitives';
import { runStoryWorkflow, toWorkItemsById, type WorkItemActor } from '../_shared/work-items-shared';

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

export function StoriesIndexPageContent(props: Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
}>) {
  const { repository, actor, initialWorkItems } = props;
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [runningStoryId, setRunningStoryId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

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

  const handleRunStoryWorkflow = async (story: DashboardWorkItemSnapshot) => {
    if (runningStoryId !== null) {
      return;
    }

    setRunningStoryId(story.id);
    setActionError(null);
    setActionNotice(null);
    try {
      const runResult = await runStoryWorkflow({
        repositoryId: repository.id,
        storyId: story.id,
        expectedRevision: story.revision,
        actor,
        errorPrefix: `Unable to run story workflow for story #${story.id}`,
      });

      if (!runResult.ok) {
        setActionError(runResult.message);
        return;
      }

      upsertWorkItems(runResult.result.story, ...runResult.result.updatedTasks);
      const startStep = runResult.result.steps.find(step => step.step === 'start_ready_tasks');
      const blockedStep = runResult.result.steps.find(step => step.step === 'generate_breakdown' && step.outcome === 'blocked');

      if (startStep?.outcome === 'partial_failure') {
        setActionError(startStep.message);
        return;
      }

      if (runResult.result.startedTasks.length > 0) {
        setActionNotice(
          `Story #${story.id} workflow ran and ${runResult.result.startedTasks.length} task${runResult.result.startedTasks.length === 1 ? '' : 's'} started.`,
        );
        return;
      }

      if (blockedStep) {
        setActionNotice(blockedStep.message);
        return;
      }

      setActionNotice(`Story #${story.id} workflow completed with no task starts.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningStoryId(null);
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
