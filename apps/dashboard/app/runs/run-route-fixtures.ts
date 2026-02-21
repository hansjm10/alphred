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
export type RunRouteTimeWindow = 'all' | '24h' | '7d' | '30d';
type RunRouteQueryParam = string | string[] | undefined;

type CreateRunRouteRecordInput = Omit<RunRouteRecord, 'workflow'> & Readonly<{ workflow?: string }>;

function createRunRouteRecord({
  id,
  repository,
  status,
  startedAtLabel,
  completedAtLabel,
  timeline,
  nodes,
  artifacts,
  routingDecisions,
  worktree,
  workflow = 'demo-tree',
}: CreateRunRouteRecordInput): RunRouteRecord {
  return {
    id,
    workflow,
    repository,
    status,
    startedAtLabel,
    completedAtLabel,
    timeline,
    nodes,
    artifacts,
    routingDecisions,
    worktree,
  };
}

function createNodeSnapshots(
  design: RunRouteStatus,
  implement: RunRouteStatus,
  review: RunRouteStatus,
): readonly RunNodeSnapshot[] {
  return [
    { nodeKey: 'design', status: design },
    { nodeKey: 'implement', status: implement },
    { nodeKey: 'review', status: review },
  ];
}

function createWorktree(branch: string, files: readonly RunWorktreeFile[]): RunRouteRecord['worktree'] {
  return { branch, files };
}

export const RUN_ROUTE_FIXTURES: readonly RunRouteRecord[] = [
  createRunRouteRecord({
    id: 412,
    repository: 'demo-repo',
    status: 'running',
    startedAtLabel: '2m ago',
    completedAtLabel: null,
    timeline: [
      { timestamp: '20:03', summary: 'Run started and queued node execution.' },
      { timestamp: '20:04', summary: 'Design node completed and implement node started.' },
      { timestamp: '20:05', summary: 'Routing decision recorded for implement node.' },
    ],
    nodes: createNodeSnapshots('completed', 'running', 'pending'),
    artifacts: ['Design notes (markdown)', 'Implementation patch (diff)'],
    routingDecisions: ['implement -> review approved'],
    worktree: createWorktree('alphred/demo-tree/412', [
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
    ]),
  }),
  createRunRouteRecord({
    id: 411,
    repository: 'sample-repo',
    status: 'failed',
    startedAtLabel: '14m ago',
    completedAtLabel: '11m ago',
    timeline: [
      { timestamp: '19:49', summary: 'Run started.' },
      { timestamp: '19:50', summary: 'Implement node failed with auth error.' },
      { timestamp: '19:51', summary: 'Run marked failed and remediation captured.' },
    ],
    nodes: createNodeSnapshots('completed', 'failed', 'pending'),
    artifacts: ['Failure log (text)', 'Auth remediation note'],
    routingDecisions: ['implement -> retry blocked until auth fixed'],
    worktree: createWorktree('alphred/demo-tree/411', [
      {
        path: 'src/ui/panel.tsx',
        changed: true,
        preview: 'Panel status badges now show auth failure context.',
        diff: '+ <StatusBadge status="failed" label="Auth error" />',
      },
    ]),
  }),
  createRunRouteRecord({
    id: 410,
    repository: 'demo-repo',
    status: 'completed',
    startedAtLabel: '27m ago',
    completedAtLabel: '20m ago',
    timeline: [
      { timestamp: '19:34', summary: 'Run started.' },
      { timestamp: '19:39', summary: 'All nodes completed.' },
      { timestamp: '19:41', summary: 'Cleanup removed temporary files.' },
    ],
    nodes: createNodeSnapshots('completed', 'completed', 'completed'),
    artifacts: ['Summary report (markdown)'],
    routingDecisions: ['review -> approved'],
    worktree: createWorktree('alphred/demo-tree/410', [
      {
        path: 'reports/final-summary.md',
        changed: false,
        preview: 'Run 410 completed with no file modifications.',
        diff: '',
      },
    ]),
  }),
];

export function normalizeRunFilter(status: RunRouteQueryParam): RunRouteFilter {
  const normalized = Array.isArray(status) ? status[0] : status;

  if (normalized === 'running' || normalized === 'failed') {
    return normalized;
  }

  return 'all';
}

export function normalizeRunRepositoryParam(
  repository: RunRouteQueryParam,
): string | null {
  const normalized = Array.isArray(repository) ? repository[0] : repository;
  if (typeof normalized !== 'string') {
    return null;
  }

  const trimmed = normalized.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

export function normalizeRunWorkflowParam(workflow: RunRouteQueryParam): string | null {
  const normalized = Array.isArray(workflow) ? workflow[0] : workflow;
  if (typeof normalized !== 'string') {
    return null;
  }

  const trimmed = normalized.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

export function normalizeRunTimeWindowParam(window: RunRouteQueryParam): RunRouteTimeWindow {
  const normalized = Array.isArray(window) ? window[0] : window;
  if (normalized === '24h' || normalized === '7d' || normalized === '30d') {
    return normalized;
  }

  return 'all';
}

export function buildRunsListHref(params: Readonly<{
  status: RunRouteFilter;
  workflow: string | null;
  repository: string | null;
  window: RunRouteTimeWindow;
}>): string {
  const searchParams = new URLSearchParams();
  if (params.status !== 'all') {
    searchParams.set('status', params.status);
  }
  if (params.workflow) {
    searchParams.set('workflow', params.workflow);
  }
  if (params.repository) {
    searchParams.set('repository', params.repository);
  }
  if (params.window !== 'all') {
    searchParams.set('window', params.window);
  }

  const query = searchParams.toString();
  return query.length === 0 ? '/runs' : `/runs?${query}`;
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
  path: RunRouteQueryParam,
): string | null {
  const defaultPath =
    run.worktree.files.find((file) => file.changed)?.path ??
    run.worktree.files[0]?.path ??
    null;
  const requestedPath = Array.isArray(path) ? path[0] : path;
  if (!requestedPath) {
    return defaultPath;
  }

  return run.worktree.files.some((file) => file.path === requestedPath)
    ? requestedPath
    : defaultPath;
}
