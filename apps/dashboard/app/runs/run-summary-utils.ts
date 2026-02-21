import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';

function statusTier(status: DashboardRunSummary['status']): number {
  if (status === 'running' || status === 'pending' || status === 'paused') {
    return 0;
  }

  if (status === 'failed') {
    return 1;
  }

  if (status === 'completed') {
    return 2;
  }

  return 3;
}

function resolveSortTimestamp(run: DashboardRunSummary): number {
  const candidate = run.completedAt ?? run.startedAt ?? run.createdAt;
  const timestamp = new Date(candidate).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function isActiveRunStatus(status: DashboardRunSummary['status']): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

export function sortRunsForDashboard(input: readonly DashboardRunSummary[]): DashboardRunSummary[] {
  return [...input].sort((left, right) => {
    const statusDifference = statusTier(left.status) - statusTier(right.status);
    if (statusDifference !== 0) {
      return statusDifference;
    }

    const leftTimestamp = resolveSortTimestamp(left);
    const rightTimestamp = resolveSortTimestamp(right);
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return right.id - left.id;
  });
}
