'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { WorkItemStatus } from '@alphred/shared';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import { ActionButton, ButtonLink } from '../../../ui/primitives';
import {
  approveStoryBreakdown,
  createWorkItem,
  generateStoryBreakdownDraft,
  moveWorkItemStatus,
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

export function StoriesIndexPageContent(props: Readonly<{
  repository: DashboardRepositoryState;
  actor: WorkItemActor;
  initialWorkItems: readonly DashboardWorkItemSnapshot[];
}>) {
  const { repository, actor, initialWorkItems } = props;
  const [workItemsById, setWorkItemsById] = useState<Readonly<Record<number, DashboardWorkItemSnapshot>>>(() =>
    toWorkItemsById(initialWorkItems),
  );
  const [newStoryTitle, setNewStoryTitle] = useState('');
  const [creatingStory, setCreatingStory] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [runningStoryId, setRunningStoryId] = useState<number | null>(null);

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

  const handleCreateStory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newStoryTitle.trim();
    if (title.length === 0) {
      setActionError('Story title is required.');
      setActionNotice(null);
      return;
    }

    setCreatingStory(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const createResult = await createWorkItem({
        repositoryId: repository.id,
        type: 'story',
        title,
        actor,
        errorPrefix: 'Unable to create story',
      });

      if (createResult.ok) {
        upsertWorkItems(createResult.workItem);
        setNewStoryTitle('');
        setActionNotice(`Created story #${createResult.workItem.id}.`);
      } else {
        setActionError(createResult.message);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create story.');
    }
    setCreatingStory(false);
  };

  const handleRunStoryWorkflow = async (story: DashboardWorkItemSnapshot) => {
    if (runningStoryId !== null) {
      return;
    }

    setRunningStoryId(story.id);
    setActionError(null);
    setActionNotice(null);

    try {
      let currentStory = story;

      if (currentStory.status === 'Draft') {
        const moveResult = await moveWorkItemStatus({
          repositoryId: repository.id,
          workItemId: currentStory.id,
          expectedRevision: currentStory.revision,
          toStatus: 'NeedsBreakdown',
          actor,
          errorPrefix: `Unable to update story #${currentStory.id}`,
        });
        if (!moveResult.ok) {
          setActionError(moveResult.message);
          return;
        }
        currentStory = moveResult.workItem;
        upsertWorkItems(currentStory);
      }

      if (currentStory.status === 'NeedsBreakdown') {
        if ((taskCountByStoryId.get(currentStory.id) ?? 0) > 0) {
          setActionError('Auto-run requires a story without child tasks while it is in Needs breakdown.');
          return;
        }

        const generated = await generateStoryBreakdownDraft({
          repositoryId: repository.id,
          storyId: currentStory.id,
          expectedRevision: currentStory.revision,
        });
        if (!generated.ok) {
          setActionError(generated.message);
          return;
        }

        currentStory = generated.story;
        upsertWorkItems(currentStory, ...generated.tasks);
      }

      if (currentStory.status !== 'BreakdownProposed') {
        setActionNotice(
          `Story #${currentStory.id} is ${formatWorkItemStatusLabel(currentStory.status)}. Open it for manual actions.`,
        );
        return;
      }

      const approved = await approveStoryBreakdown({
        repositoryId: repository.id,
        storyId: currentStory.id,
        expectedRevision: currentStory.revision,
        actor,
      });
      if (!approved.ok) {
        setActionError(approved.message);
        return;
      }

      upsertWorkItems(approved.story, ...approved.tasks);

      const startErrors: string[] = [];
      const startedTasks: DashboardWorkItemSnapshot[] = [];
      for (const task of approved.tasks) {
        if (task.type !== 'task' || task.status !== 'Ready') {
          continue;
        }

        const moveResult = await moveWorkItemStatus({
          repositoryId: repository.id,
          workItemId: task.id,
          expectedRevision: task.revision,
          toStatus: 'InProgress',
          actor,
          errorPrefix: `Unable to start task #${task.id}`,
        });
        if (moveResult.ok) {
          startedTasks.push(moveResult.workItem);
        } else {
          startErrors.push(moveResult.message);
        }
      }

      if (startedTasks.length > 0) {
        upsertWorkItems(...startedTasks);
      }

      if (startErrors.length > 0) {
        setActionError(startErrors.join(' '));
      } else if (startedTasks.length === 0) {
        setActionNotice(`Story #${currentStory.id} approved. No Ready tasks were available to start.`);
      } else {
        setActionNotice(
          `Story #${currentStory.id} approved and ${startedTasks.length} task${startedTasks.length === 1 ? '' : 's'} started.`,
        );
      }
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
          <h5>New story</h5>
          <form className="board-inline-editor" onSubmit={(event) => void handleCreateStory(event)}>
            <input
              type="text"
              aria-label="Story title"
              placeholder="Describe the user story"
              value={newStoryTitle}
              onChange={(event) => {
                setNewStoryTitle(event.currentTarget.value);
              }}
            />
            <ActionButton
              type="submit"
              tone="primary"
              className="board-inline-action"
              disabled={creatingStory}
              aria-disabled={creatingStory}
            >
              {creatingStory ? 'Creating…' : 'Create story'}
            </ActionButton>
          </form>
        </div>

        <div className="board-detail__section board-detail__section--divider">
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
                    {story.status === 'Draft'
                    || story.status === 'NeedsBreakdown'
                    || story.status === 'BreakdownProposed' ? (
                      <ActionButton
                        tone="primary"
                        onClick={() => void handleRunStoryWorkflow(story)}
                        disabled={
                          creatingStory
                          || runningStoryId !== null
                          || (story.status === 'NeedsBreakdown' && (taskCountByStoryId.get(story.id) ?? 0) > 0)
                        }
                        aria-disabled={
                          creatingStory
                          || runningStoryId !== null
                          || (story.status === 'NeedsBreakdown' && (taskCountByStoryId.get(story.id) ?? 0) > 0)
                        }
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
