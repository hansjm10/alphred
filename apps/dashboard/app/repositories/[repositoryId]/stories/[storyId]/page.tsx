import { notFound } from 'next/navigation';
import type { DashboardRepositoryState } from '@dashboard/server/dashboard-contracts';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { loadGitHubAuthGate } from '../../../../ui/load-github-auth-gate';
import { loadDashboardRepositories } from '../../../load-dashboard-repositories';
import { StoryDetailPageContent } from './story-detail-client';

type StoryDetailPageProps = Readonly<{
  params: Promise<{
    repositoryId: string;
    storyId: string;
  }>;
}>;

type WorkItemActor = Readonly<{
  actorType: 'human' | 'agent' | 'system';
  actorLabel: string;
}>;

function parsePositiveId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function resolveActor(authGate: Awaited<ReturnType<typeof loadGitHubAuthGate>>): WorkItemActor {
  return {
    actorType: 'human',
    actorLabel: authGate.state === 'authenticated' && authGate.user ? authGate.user : 'dashboard',
  };
}

function resolveRepository(
  repositories: readonly DashboardRepositoryState[],
  repositoryId: number,
): DashboardRepositoryState | null {
  return repositories.find(candidate => candidate.id === repositoryId) ?? null;
}

export default async function StoryDetailPage({ params }: StoryDetailPageProps) {
  const { repositoryId, storyId } = await params;
  const parsedRepositoryId = parsePositiveId(repositoryId);
  const parsedStoryId = parsePositiveId(storyId);
  if (parsedRepositoryId === null || parsedStoryId === null) {
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
  const story = bootstrap.workItems.find(item => item.id === parsedStoryId && item.type === 'story') ?? null;
  if (!story) {
    notFound();
  }

  const proposal = await service.getStoryBreakdownProposal({ repositoryId: parsedRepositoryId, storyId: parsedStoryId });

  return (
    <StoryDetailPageContent
      repository={repository}
      actor={resolveActor(authGate)}
      storyId={parsedStoryId}
      initialLatestEventId={bootstrap.latestEventId}
      initialWorkItems={bootstrap.workItems}
      initialProposal={proposal.proposal}
    />
  );
}
