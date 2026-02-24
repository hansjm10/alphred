export type RunRouteFilter = 'all' | 'running' | 'failed';

export function normalizeRunFilter(status: string | string[] | undefined): RunRouteFilter {
  const normalized = Array.isArray(status) ? status[0] : status;

  if (normalized === 'running' || normalized === 'failed') {
    return normalized;
  }

  return 'all';
}

export function resolveRunFilterHref(filter: RunRouteFilter): string {
  if (filter === 'all') {
    return '/runs';
  }

  return `/runs?status=${filter}`;
}

export function buildRunDetailHref(runId: number): string {
  return `/runs/${runId}`;
}

export function buildRunWorktreeHref(runId: number, path?: string): string {
  if (!path) {
    return `/runs/${runId}/worktree`;
  }

  return `/runs/${runId}/worktree?path=${encodeURIComponent(path)}`;
}
