import { notFound } from 'next/navigation';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';
import { createDashboardService } from '@dashboard/server/dashboard-service';
import { loadGitHubAuthGate } from '../../../../ui/load-github-auth-gate';
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

export default async function StoryDetailPage({ params }: StoryDetailPageProps) {
  const { repositoryId, storyId } = await params;
  const parsedRepositoryId = parsePositiveId(repositoryId);
  const parsedStoryId = parsePositiveId(storyId);
  if (parsedRepositoryId === null || parsedStoryId === null) {
    notFound();
  }

  const service = createDashboardService();
  const authGatePromise = loadGitHubAuthGate();
  let repositoryResult: Awaited<ReturnType<typeof service.getRepository>>;
  try {
    repositoryResult = await service.getRepository(parsedRepositoryId);
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.status === 404) {
      notFound();
    }
    throw error;
  }
  const authGate = await authGatePromise;

  const bootstrap = await service.getRepositoryBoardBootstrap({ repositoryId: parsedRepositoryId });
  const story = bootstrap.workItems.find(item => item.id === parsedStoryId && item.type === 'story') ?? null;
  if (!story) {
    notFound();
  }

  const [proposal, workspace] = await Promise.all([
    service.getStoryBreakdownProposal({ repositoryId: parsedRepositoryId, storyId: parsedStoryId }),
    service.getStoryWorkspace({ repositoryId: parsedRepositoryId, storyId: parsedStoryId }),
  ]);

  return (
    <StoryDetailPageContent
      repository={repositoryResult.repository}
      actor={resolveActor(authGate)}
      storyId={parsedStoryId}
      initialLatestEventId={bootstrap.latestEventId}
      initialWorkItems={bootstrap.workItems}
      initialProposal={proposal.proposal}
      initialWorkspace={workspace.workspace}
    />
  );
}
