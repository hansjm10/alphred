import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WorkItemStatus } from '@alphred/shared';
import type { DashboardRepositoryState, DashboardWorkItemSnapshot } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { ButtonLink } from '../../../ui/primitives';
import { loadDashboardRepositories } from '../../load-dashboard-repositories';

type StoriesIndexPageProps = Readonly<{
  params: Promise<{
    repositoryId: string;
  }>;
}>;

function parsePositiveId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function resolveRepository(
  repositories: readonly DashboardRepositoryState[],
  repositoryId: number,
): DashboardRepositoryState | null {
  return repositories.find(candidate => candidate.id === repositoryId) ?? null;
}

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

function countChildTasks(workItems: readonly DashboardWorkItemSnapshot[], storyId: number): number {
  return workItems.filter(item => item.type === 'task' && item.parentId === storyId).length;
}

export default async function StoriesIndexPage({ params }: StoriesIndexPageProps) {
  const { repositoryId } = await params;
  const parsedRepositoryId = parsePositiveId(repositoryId);
  if (parsedRepositoryId === null) {
    notFound();
  }

  const service = createDashboardService();
  const repositories = await loadDashboardRepositories(false);

  const repository = resolveRepository(repositories, parsedRepositoryId);
  if (!repository) {
    notFound();
  }

  const bootstrap = await service.getRepositoryBoardBootstrap({ repositoryId: parsedRepositoryId });

  const stories = bootstrap.workItems
    .filter(item => item.type === 'story')
    .sort((a, b) => b.id - a.id);

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
                      <span className="meta-text">{countChildTasks(bootstrap.workItems, story.id)} tasks</span>
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
