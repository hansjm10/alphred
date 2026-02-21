import type {
  DashboardRepositoryState,
  DashboardRunSummary,
  DashboardWorkflowTreeSummary,
} from '../../src/server/dashboard-contracts';
import type { GitHubAuthGate } from '../ui/github-auth';
import { loadGitHubAuthGate } from '../ui/load-github-auth-gate';
import { loadDashboardRepositories } from '../repositories/load-dashboard-repositories';
import { loadDashboardRunSummaries, loadDashboardWorkflowTrees } from './load-dashboard-runs';
import {
  normalizeRunFilter,
  normalizeRunRepositoryParam,
  normalizeRunTimeWindowParam,
  normalizeRunWorkflowParam,
} from './run-route-fixtures';
import { RunsPageContent } from './runs-client';

type RunsPageProps = Readonly<{
  runs?: readonly DashboardRunSummary[];
  workflows?: readonly DashboardWorkflowTreeSummary[];
  repositories?: readonly DashboardRepositoryState[];
  authGate?: GitHubAuthGate;
  searchParams?: Promise<{
    status?: string | string[];
    workflow?: string | string[];
    repository?: string | string[];
    window?: string | string[];
  }> | {
    status?: string | string[];
    workflow?: string | string[];
    repository?: string | string[];
    window?: string | string[];
  };
}>;

export { RunsPageContent } from './runs-client';

export default async function RunsPage({
  runs,
  workflows,
  repositories,
  authGate,
  searchParams,
}: RunsPageProps = {}) {
  const resolvedSearchParams = await searchParams;
  const activeFilter = normalizeRunFilter(resolvedSearchParams?.status);
  const requestedRepository = normalizeRunRepositoryParam(resolvedSearchParams?.repository);
  const requestedWorkflow = normalizeRunWorkflowParam(resolvedSearchParams?.workflow);
  const activeWindow = normalizeRunTimeWindowParam(resolvedSearchParams?.window);
  const [resolvedRuns, resolvedWorkflows, resolvedRepositories, resolvedAuthGate] = await Promise.all([
    runs ?? loadDashboardRunSummaries(),
    workflows ?? loadDashboardWorkflowTrees(),
    repositories ?? loadDashboardRepositories(),
    authGate ?? loadGitHubAuthGate(),
  ]);
  const initialRepositoryName =
    requestedRepository !== null &&
    resolvedRepositories.some(
      (repository) =>
        repository.cloneStatus === 'cloned' && repository.name === requestedRepository,
    )
      ? requestedRepository
      : null;
  const activeWorkflowKey =
    requestedWorkflow !== null &&
    resolvedWorkflows.some((workflow) => workflow.treeKey === requestedWorkflow)
      ? requestedWorkflow
      : null;

  return (
    <RunsPageContent
      runs={resolvedRuns}
      workflows={resolvedWorkflows}
      repositories={resolvedRepositories}
      authGate={resolvedAuthGate}
      activeFilter={activeFilter}
      activeRepositoryName={initialRepositoryName}
      activeWorkflowKey={activeWorkflowKey}
      activeWindow={activeWindow}
    />
  );
}
