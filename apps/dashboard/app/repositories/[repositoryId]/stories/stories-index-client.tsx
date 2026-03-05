'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import type { WorkItemStatus } from '@alphred/shared';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import { ActionButton, ButtonLink } from '../../../ui/primitives';
import { createWorkItem, toWorkItemsById, type WorkItemActor } from '../_shared/work-items-shared';

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

  const handleCreateStory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newStoryTitle.trim();
    if (title.length === 0) {
      setActionError('Story title is required.');
      return;
    }

    setCreatingStory(true);
    setActionError(null);
    try {
      const createResult = await createWorkItem({
        repositoryId: repository.id,
        type: 'story',
        title,
        actor,
        errorPrefix: 'Unable to create story',
      });

      if (createResult.ok) {
        setWorkItemsById(previous => ({
          ...previous,
          [createResult.workItem.id]: createResult.workItem,
        }));
        setNewStoryTitle('');
      } else {
        setActionError(createResult.message);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create story.');
    }
    setCreatingStory(false);
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
                  <ButtonLink href={`/repositories/${repository.id}/stories/${story.id}`} tone="secondary">
                    Open
                  </ButtonLink>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
