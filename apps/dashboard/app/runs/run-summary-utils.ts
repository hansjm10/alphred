import type { DashboardRunSummary } from '../../src/server/dashboard-contracts';

const STATUS_PRIORITY: Readonly<Record<DashboardRunSummary['status'], number>> = {
  running: 0,
  paused: 1,
  pending: 2,
  failed: 3,
  completed: 4,
  cancelled: 5,
};

export function isActiveRunStatus(status: DashboardRunSummary['status']): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

export function sortRunsForDashboard(input: readonly DashboardRunSummary[]): DashboardRunSummary[] {
  return [...input].sort((left, right) => {
    const statusDifference = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (statusDifference !== 0) {
      return statusDifference;
    }

    const leftTimestamp = new Date(left.startedAt ?? left.createdAt).getTime();
    const rightTimestamp = new Date(right.startedAt ?? right.createdAt).getTime();
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return right.id - left.id;
  });
}

