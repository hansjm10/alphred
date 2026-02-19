import { notFound } from 'next/navigation';
import type {
  DashboardRepositoryState,
  DashboardRunDetail,
  DashboardRunSummary,
} from '../../../src/server/dashboard-contracts';
import { DashboardIntegrationError } from '../../../src/server/dashboard-errors';
import { loadDashboardRepositories } from '../../repositories/load-dashboard-repositories';
import { loadDashboardRunDetail } from '../load-dashboard-runs';
import { ActionButton, ButtonLink, Card, Panel, StatusBadge } from '../../ui/primitives';

type RunDetailPageProps = Readonly<{
  runDetail?: DashboardRunDetail;
  repositories?: readonly DashboardRepositoryState[];
  params: Promise<{
    runId: string;
  }>;
}>;

type TimelineItem = Readonly<{
  key: string;
  timestamp: Date;
  summary: string;
}>;

type PrimaryActionState = Readonly<{
  label: string;
  href: string | null;
  disabledReason: string | null;
}>;

function parseRunId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function parseDateValue(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function formatDateTime(value: string | null, fallback: string): string {
  const parsed = parseDateValue(value);
  if (parsed === null) {
    return fallback;
  }

  return parsed.toLocaleString();
}

function formatTimelineTime(value: Date): string {
  return value.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function toNodeTerminalSummary(node: DashboardRunDetail['nodes'][number]): string {
  switch (node.status) {
    case 'completed':
      return `${node.nodeKey} completed.`;
    case 'failed':
      return `${node.nodeKey} failed.`;
    case 'cancelled':
      return `${node.nodeKey} was cancelled.`;
    case 'skipped':
      return `${node.nodeKey} was skipped.`;
    default:
      return `${node.nodeKey} finished with status ${node.status}.`;
  }
}

function buildTimeline(detail: DashboardRunDetail): readonly TimelineItem[] {
  const fallbackDate = parseDateValue(detail.run.createdAt) ?? new Date(0);
  const events: TimelineItem[] = [];

  const startedAt = parseDateValue(detail.run.startedAt);
  if (startedAt) {
    events.push({
      key: `run-start-${detail.run.id}`,
      timestamp: startedAt,
      summary: 'Run started.',
    });
  }

  const completedAt = parseDateValue(detail.run.completedAt);
  if (completedAt) {
    events.push({
      key: `run-terminal-${detail.run.id}`,
      timestamp: completedAt,
      summary: `Run reached terminal state (${detail.run.status}).`,
    });
  }

  for (const node of detail.nodes) {
    const nodeStartedAt = parseDateValue(node.startedAt);
    if (nodeStartedAt) {
      events.push({
        key: `node-start-${node.id}`,
        timestamp: nodeStartedAt,
        summary: `${node.nodeKey} started (attempt ${node.attempt}).`,
      });
    }

    const nodeCompletedAt = parseDateValue(node.completedAt);
    if (nodeCompletedAt) {
      events.push({
        key: `node-terminal-${node.id}`,
        timestamp: nodeCompletedAt,
        summary: toNodeTerminalSummary(node),
      });
    }
  }

  for (const artifact of detail.artifacts) {
    const createdAt = parseDateValue(artifact.createdAt) ?? fallbackDate;
    events.push({
      key: `artifact-${artifact.id}`,
      timestamp: createdAt,
      summary: `Artifact captured (${artifact.artifactType}/${artifact.contentType}).`,
    });
  }

  for (const decision of detail.routingDecisions) {
    const createdAt = parseDateValue(decision.createdAt) ?? fallbackDate;
    events.push({
      key: `decision-${decision.id}`,
      timestamp: createdAt,
      summary: `Routing decision: ${decision.decisionType}.`,
    });
  }

  return events.sort((left, right) => {
    const timeDifference = left.timestamp.getTime() - right.timestamp.getTime();
    if (timeDifference !== 0) {
      return timeDifference;
    }

    return left.key.localeCompare(right.key);
  });
}

function resolveRepositoryContext(
  detail: DashboardRunDetail,
  repositories: readonly DashboardRepositoryState[],
): string {
  if (detail.worktrees.length === 0) {
    return 'Not attached';
  }

  const repositoryNameById = new Map(repositories.map((repository) => [repository.id, repository.name]));
  const repositoryContextWorktree =
    detail.worktrees.find((worktree) => worktree.status === 'active') ??
    detail.worktrees[detail.worktrees.length - 1];
  if (!repositoryContextWorktree) {
    return 'Not attached';
  }

  return (
    repositoryNameById.get(repositoryContextWorktree.repositoryId) ??
    `Repository #${repositoryContextWorktree.repositoryId}`
  );
}

function resolvePrimaryAction(
  run: DashboardRunSummary,
  hasWorktree: boolean,
): PrimaryActionState {
  if (run.status === 'completed') {
    if (hasWorktree) {
      return {
        label: 'Open Worktree',
        href: `/runs/${run.id}/worktree`,
        disabledReason: null,
      };
    }

    return {
      label: 'Open Worktree',
      href: null,
      disabledReason: 'No worktree was captured for this run.',
    };
  }

  if (run.status === 'running') {
    return {
      label: 'Pause',
      href: null,
      disabledReason: 'Pause action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'paused') {
    return {
      label: 'Resume',
      href: null,
      disabledReason: 'Resume action is blocked until lifecycle controls are available.',
    };
  }

  if (run.status === 'failed') {
    return {
      label: 'Retry Failed Node',
      href: null,
      disabledReason: 'Retry action is blocked until retry controls are available.',
    };
  }

  if (run.status === 'pending') {
    return {
      label: 'Pending Start',
      href: null,
      disabledReason: 'Run has not started yet.',
    };
  }

  return {
    label: 'Run Cancelled',
    href: null,
    disabledReason: 'Cancelled runs cannot be resumed from this view.',
  };
}

function truncatePreview(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 137)}...`;
}

export default async function RunDetailPage({
  params,
  runDetail,
  repositories,
}: RunDetailPageProps) {
  const { runId } = await params;
  const parsedRunId = parseRunId(runId);
  if (parsedRunId === null) {
    notFound();
  }

  let detail: DashboardRunDetail;
  try {
    detail = runDetail ?? (await loadDashboardRunDetail(parsedRunId));
  } catch (error) {
    if (error instanceof DashboardIntegrationError && error.code === 'not_found') {
      notFound();
    }

    throw error;
  }
  const resolvedRepositories = repositories ?? (await loadDashboardRepositories());

  const timeline = buildTimeline(detail);
  const repositoryContext = resolveRepositoryContext(detail, resolvedRepositories);
  const primaryAction = resolvePrimaryAction(detail.run, detail.worktrees.length > 0);

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>{`Run #${detail.run.id}`}</h2>
        <p>Timeline and node lifecycle reflect persisted run data from dashboard APIs.</p>
      </section>

      <div className="page-grid">
        <Card title="Run summary" description="Current status and context">
          <ul className="entity-list">
            <li>
              <span>Status</span>
              <StatusBadge status={detail.run.status} />
            </li>
            <li>
              <span>Workflow</span>
              <span className="meta-text">{`${detail.run.tree.name} (${detail.run.tree.treeKey})`}</span>
            </li>
            <li>
              <span>Repository context</span>
              <span className="meta-text">{repositoryContext}</span>
            </li>
            <li>
              <span>Worktrees</span>
              <span className="meta-text">{detail.worktrees.length}</span>
            </li>
            <li>
              <span>Started</span>
              <span className="meta-text">{formatDateTime(detail.run.startedAt, 'Not started')}</span>
            </li>
            <li>
              <span>Completed</span>
              <span className="meta-text">{formatDateTime(detail.run.completedAt, 'In progress')}</span>
            </li>
          </ul>
        </Card>

        <Panel title="Actions" description="Invalid actions are blocked by current lifecycle state.">
          <div className="action-row">
            {primaryAction.href ? (
              <ButtonLink href={primaryAction.href} tone="primary">
                {primaryAction.label}
              </ButtonLink>
            ) : (
              <ActionButton tone="primary" disabled aria-disabled="true" title={primaryAction.disabledReason ?? undefined}>
                {primaryAction.label}
              </ActionButton>
            )}
            <ButtonLink href="/runs">Back to Runs</ButtonLink>
          </div>
          {primaryAction.disabledReason ? <p className="meta-text run-action-feedback">{primaryAction.disabledReason}</p> : null}
        </Panel>
      </div>

      <div className="page-grid">
        <Card title="Timeline" description="Latest run events">
          <ol className="page-stack" aria-label="Run timeline">
            {timeline.length > 0 ? (
              timeline.map((event) => (
                <li key={event.key}>
                  <p className="meta-text">{formatTimelineTime(event.timestamp)}</p>
                  <p>{event.summary}</p>
                </li>
              ))
            ) : (
              <li>
                <p>No lifecycle events captured yet.</p>
              </li>
            )}
          </ol>
        </Card>

        <Panel title="Node status" description="Node lifecycle snapshot">
          <ul className="entity-list">
            {detail.nodes.length > 0 ? (
              detail.nodes.map((node) => (
                <li key={node.id}>
                  <span>{`${node.nodeKey} (attempt ${node.attempt})`}</span>
                  <StatusBadge status={node.status} />
                </li>
              ))
            ) : (
              <li>
                <span>No run nodes have been materialized yet.</span>
              </li>
            )}
          </ul>
        </Panel>
      </div>

      <Card title="Artifacts and routing decisions" description="Recent snapshots for operator triage.">
        <p className="meta-text">Artifacts</p>
        {detail.artifacts.length === 0 ? <p>No artifacts captured yet.</p> : null}
        <ul className="page-stack" aria-label="Run artifacts">
          {detail.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <p>{`${artifact.artifactType} (${artifact.contentType})`}</p>
              <p className="meta-text">{truncatePreview(artifact.contentPreview)}</p>
            </li>
          ))}
        </ul>

        <p className="meta-text">Routing decisions</p>
        {detail.routingDecisions.length === 0 ? <p>No routing decisions captured yet.</p> : null}
        <ul className="page-stack" aria-label="Run routing decisions">
          {detail.routingDecisions.map((decision) => (
            <li key={decision.id}>
              <p>{decision.decisionType}</p>
              <p className="meta-text">{decision.rationale ?? 'No rationale provided.'}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
