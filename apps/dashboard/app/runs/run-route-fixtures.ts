export type RunRouteStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';

type RunTimelineEvent = Readonly<{
  timestamp: string;
  summary: string;
}>;

type RunNodeSnapshot = Readonly<{
  nodeKey: string;
  status: RunRouteStatus;
}>;

type RunWorktreeFile = Readonly<{
  path: string;
  changed: boolean;
  preview: string;
  diff: string;
}>;

export type RunRouteRecord = Readonly<{
  id: number;
  workflow: string;
  repository: string;
  status: RunRouteStatus;
  startedAtLabel: string;
  completedAtLabel: string | null;
  timeline: readonly RunTimelineEvent[];
  nodes: readonly RunNodeSnapshot[];
  artifacts: readonly string[];
  routingDecisions: readonly string[];
  worktree: Readonly<{
    branch: string;
    files: readonly RunWorktreeFile[];
  }>;
}>;

export type RunRouteFilter = 'all' | 'running' | 'failed';

export const RUN_ROUTE_FIXTURES: readonly RunRouteRecord[] = [
  {
    id: 412,
    workflow: 'demo-tree',
    repository: 'demo-repo',
    status: 'running',
    startedAtLabel: '2m ago',
    completedAtLabel: null,
    timeline: [
      { timestamp: '20:03', summary: 'Run started and queued node execution.' },
      { timestamp: '20:04', summary: 'Design node completed and implement node started.' },
      { timestamp: '20:05', summary: 'Routing decision recorded for implement node.' },
    ],
    nodes: [
      { nodeKey: 'design', status: 'completed' },
      { nodeKey: 'implement', status: 'running' },
      { nodeKey: 'review', status: 'pending' },
    ],
    artifacts: ['Design notes (markdown)', 'Implementation patch (diff)'],
    routingDecisions: ['implement -> review approved'],
    worktree: {
      branch: 'alphred/demo-tree/412',
      files: [
        {
          path: 'src/core/engine.ts',
          changed: true,
          preview: 'Engine loop now emits lifecycle checkpoints.',
          diff: '+ emitLifecycleCheckpoint(runId, "implement-started")',
        },
        {
          path: 'apps/dashboard/app/runs/page.tsx',
          changed: true,
          preview: 'Runs table now links to canonical run detail routes.',
          diff: '+ <Link href="/runs/412">Open</Link>',
        },
        {
          path: 'README.md',
          changed: false,
          preview: 'Project notes for operator sequence.',
          diff: '+ Clarified run detail and worktree deep-link model.',
        },
      ],
    },
  },
  {
    id: 411,
    workflow: 'demo-tree',
    repository: 'sample-repo',
    status: 'failed',
    startedAtLabel: '14m ago',
    completedAtLabel: '11m ago',
    timeline: [
      { timestamp: '19:49', summary: 'Run started.' },
      { timestamp: '19:50', summary: 'Implement node failed with auth error.' },
      { timestamp: '19:51', summary: 'Run marked failed and remediation captured.' },
    ],
    nodes: [
      { nodeKey: 'design', status: 'completed' },
      { nodeKey: 'implement', status: 'failed' },
      { nodeKey: 'review', status: 'pending' },
    ],
    artifacts: ['Failure log (text)', 'Auth remediation note'],
    routingDecisions: ['implement -> retry blocked until auth fixed'],
    worktree: {
      branch: 'alphred/demo-tree/411',
      files: [
        {
          path: 'src/ui/panel.tsx',
          changed: true,
          preview: 'Panel status badges now show auth failure context.',
          diff: '+ <StatusBadge status="failed" label="Auth error" />',
        },
      ],
    },
  },
  {
    id: 410,
    workflow: 'demo-tree',
    repository: 'demo-repo',
    status: 'completed',
    startedAtLabel: '27m ago',
    completedAtLabel: '20m ago',
    timeline: [
      { timestamp: '19:34', summary: 'Run started.' },
      { timestamp: '19:39', summary: 'All nodes completed.' },
      { timestamp: '19:41', summary: 'Cleanup removed temporary files.' },
    ],
    nodes: [
      { nodeKey: 'design', status: 'completed' },
      { nodeKey: 'implement', status: 'completed' },
      { nodeKey: 'review', status: 'completed' },
    ],
    artifacts: ['Summary report (markdown)'],
    routingDecisions: ['review -> approved'],
    worktree: {
      branch: 'alphred/demo-tree/410',
      files: [],
    },
  },
] as const;

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

export function listRunsForFilter(filter: RunRouteFilter): readonly RunRouteRecord[] {
  if (filter === 'all') {
    return RUN_ROUTE_FIXTURES;
  }

  return RUN_ROUTE_FIXTURES.filter((run) => run.status === filter);
}

export function findRunByParam(runIdParam: string): RunRouteRecord | null {
  const runId = Number(runIdParam);
  if (!Number.isInteger(runId) || runId < 1) {
    return null;
  }

  return RUN_ROUTE_FIXTURES.find((run) => run.id === runId) ?? null;
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

export function resolveWorktreePath(
  run: RunRouteRecord,
  path: string | string[] | undefined,
): string | null {
  const requestedPath = Array.isArray(path) ? path[0] : path;
  if (!requestedPath) {
    return run.worktree.files[0]?.path ?? null;
  }

  return run.worktree.files.some((file) => file.path === requestedPath)
    ? requestedPath
    : (run.worktree.files[0]?.path ?? null);
}

