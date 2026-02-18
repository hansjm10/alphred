import type { DashboardRepositoryState } from '../../src/server/dashboard-contracts';
import type { GitHubAuthGate } from '../ui/github-auth';
import { loadGitHubAuthGate } from '../ui/load-github-auth-gate';
import { loadDashboardRepositories } from './load-dashboard-repositories';
import { RepositoriesPageContent } from './repositories-client';

type RepositoriesPageProps = Readonly<{
  repositories?: readonly DashboardRepositoryState[];
  authGate?: GitHubAuthGate;
}>;

export { RepositoriesPageContent };

export default async function RepositoriesPage({
  repositories,
  authGate,
}: RepositoriesPageProps = {}) {
  const [resolvedRepositories, resolvedAuthGate] = await Promise.all([
    repositories ?? loadDashboardRepositories(),
    authGate ?? loadGitHubAuthGate(),
  ]);

  return <RepositoriesPageContent repositories={resolvedRepositories} authGate={resolvedAuthGate} />;
}
