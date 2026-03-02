import { createDashboardService } from '../../../../src/server/dashboard-service';
import { loadGitHubAuthGate } from '../../../ui/load-github-auth-gate';
import { notFound } from 'next/navigation';
import { RepositoryBoardPageContent } from './repository-board-client';

type RepositoryBoardPageProps = Readonly<{
  params: Promise<{
    name: string;
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
  const { name } = await params;
  const service = createDashboardService();

  const [repositories, authGate] = await Promise.all([
    service.listRepositories(),
    loadGitHubAuthGate(),
  ]);

  const repository = repositories.find(candidate => candidate.name === name) ?? null;
  if (!repository) {
    notFound();
  }

  const [workItemsResult, boardEventsSnapshot] = await Promise.all([
    service.listWorkItems(repository.id),
    service.getRepositoryBoardEventsSnapshot({ repositoryId: repository.id, lastEventId: 0, limit: 1 }),
  ]);

  return (
    <RepositoryBoardPageContent
      repository={repository}
      actor={resolveActor(authGate)}
      initialLatestEventId={boardEventsSnapshot.latestEventId}
      initialWorkItems={workItemsResult.workItems}
    />
  );
}
