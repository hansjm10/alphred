import { notFound } from 'next/navigation';
import type { DashboardRepositoryState } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { loadDashboardRepositories } from '../../load-dashboard-repositories';
import { StoriesIndexPageContent } from './stories-index-client';

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

  return (
    <StoriesIndexPageContent
      repository={repository}
      actor={{ actorType: 'human', actorLabel: 'dashboard' }}
      initialWorkItems={bootstrap.workItems}
    />
  );
}
