import { createDashboardService } from '@dashboard/server/dashboard-service';
import { loadGitHubAuthGate } from '../../../ui/load-github-auth-gate';
import { notFound } from 'next/navigation';
import { RepositoryBoardPageContent } from './repository-board-client';

type RepositoryBoardPageProps = Readonly<{
  params: Promise<{
    repositoryId: string;
  }>;
}>;

type WorkItemActor = Readonly<{
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
}>;

function resolveActor(authGate: Awaited<ReturnType<typeof loadGitHubAuthGate>>): WorkItemActor {
  return {
    actorType: 'human',
    actorLabel: authGate.state === 'authenticated' && authGate.user ? authGate.user : 'dashboard',
  };
}

export default async function RepositoryBoardPage({ params }: RepositoryBoardPageProps) {
  const { repositoryId } = await params;
  const parsedRepositoryId = Number(repositoryId);
  if (!Number.isInteger(parsedRepositoryId) || parsedRepositoryId < 1) {
    notFound();
  }
  const service = createDashboardService();

  const [repositories, authGate] = await Promise.all([
    service.listRepositories({ includeArchived: false }),
    loadGitHubAuthGate(),
  ]);

  const repository = repositories.find(candidate => candidate.id === parsedRepositoryId) ?? null;
  if (!repository) {
    notFound();
  }

  const bootstrap = await service.getRepositoryBoardBootstrap({ repositoryId: repository.id });

  return (
    <RepositoryBoardPageContent
      repository={repository}
      actor={resolveActor(authGate)}
      initialLatestEventId={bootstrap.latestEventId}
      initialWorkItems={bootstrap.workItems}
    />
  );
}
