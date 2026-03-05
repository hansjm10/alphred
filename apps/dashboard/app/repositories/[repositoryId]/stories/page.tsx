import { notFound } from 'next/navigation';
import type { DashboardRepositoryState } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { loadGitHubAuthGate } from '../../../ui/load-github-auth-gate';
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

function resolveActor(authGate: Awaited<ReturnType<typeof loadGitHubAuthGate>>): {
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
} {
  return {
    actorType: 'human',
    actorLabel: authGate.state === 'authenticated' && authGate.user ? authGate.user : 'dashboard',
  };
}

export default async function StoriesIndexPage({ params }: StoriesIndexPageProps) {
  const { repositoryId } = await params;
  const parsedRepositoryId = parsePositiveId(repositoryId);
  if (parsedRepositoryId === null) {
    notFound();
  }

  const service = createDashboardService();
  const [repositories, authGate] = await Promise.all([
    loadDashboardRepositories(false),
    loadGitHubAuthGate(),
  ]);

  const repository = resolveRepository(repositories, parsedRepositoryId);
  if (!repository) {
    notFound();
  }

  const bootstrap = await service.getRepositoryBoardBootstrap({ repositoryId: parsedRepositoryId });
  return <StoriesIndexPageContent repository={repository} actor={resolveActor(authGate)} initialWorkItems={bootstrap.workItems} />;
}
