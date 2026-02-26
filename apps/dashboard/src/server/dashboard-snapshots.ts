import type { RepositorySyncDetails } from '@alphred/git';
import type { RepositoryConfig } from '@alphred/shared';
import type {
  DashboardArtifactSnapshot,
  DashboardRepositoryState,
  DashboardRepositorySyncDetails,
  DashboardRoutingDecisionSnapshot,
  DashboardRunNodeDiagnosticPayload,
  DashboardRunNodeDiagnosticsSnapshot,
  DashboardRunNodeStreamEvent,
  DashboardRunWorktreeMetadata,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';

const MAX_ARTIFACT_PREVIEW_LENGTH = 280;

export function toRepositoryState(repository: RepositoryConfig): DashboardRepositoryState {
  return {
    id: repository.id,
    name: repository.name,
    provider: repository.provider,
    remoteRef: repository.remoteRef,
    remoteUrl: repository.remoteUrl,
    defaultBranch: repository.defaultBranch,
    branchTemplate: repository.branchTemplate,
    cloneStatus: repository.cloneStatus,
    localPath: repository.localPath,
  };
}

export function toRepositorySyncDetails(
  sync: RepositorySyncDetails | undefined,
  fallbackBranch: string,
): DashboardRepositorySyncDetails {
  if (!sync) {
    return {
      mode: 'fetch',
      strategy: null,
      branch: fallbackBranch,
      status: 'fetched',
      conflictMessage: null,
    };
  }

  return {
    mode: sync.mode,
    strategy: sync.strategy,
    branch: sync.branch,
    status: sync.status,
    conflictMessage: sync.conflictMessage,
  };
}

export function createArtifactSnapshot(
  artifact: {
    id: number;
    runNodeId: number;
    artifactType: string;
    contentType: string;
    content: string;
    createdAt: string;
  },
): DashboardArtifactSnapshot {
  return {
    id: artifact.id,
    runNodeId: artifact.runNodeId,
    artifactType: artifact.artifactType as DashboardArtifactSnapshot['artifactType'],
    contentType: artifact.contentType as DashboardArtifactSnapshot['contentType'],
    contentPreview: artifact.content.slice(0, MAX_ARTIFACT_PREVIEW_LENGTH),
    createdAt: artifact.createdAt,
  };
}

export function createRoutingDecisionSnapshot(
  decision: {
    id: number;
    runNodeId: number;
    decisionType: string;
    rationale: string | null;
    createdAt: string;
  },
): DashboardRoutingDecisionSnapshot {
  return {
    id: decision.id,
    runNodeId: decision.runNodeId,
    decisionType: decision.decisionType as DashboardRoutingDecisionSnapshot['decisionType'],
    rationale: decision.rationale,
    createdAt: decision.createdAt,
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRunNodeDiagnosticsSnapshot(
  diagnosticsRow: {
    id: number;
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    outcome: string;
    eventCount: number;
    retainedEventCount: number;
    droppedEventCount: number;
    redacted: number;
    truncated: number;
    payloadChars: number;
    createdAt: string;
    diagnostics: unknown;
  },
): DashboardRunNodeDiagnosticsSnapshot {
  const fallbackPayload: DashboardRunNodeDiagnosticPayload = {
    schemaVersion: 1,
    workflowRunId: diagnosticsRow.workflowRunId,
    runNodeId: diagnosticsRow.runNodeId,
    nodeKey: 'unknown',
    attempt: diagnosticsRow.attempt,
    outcome: diagnosticsRow.outcome as DashboardRunNodeDiagnosticPayload['outcome'],
    status: diagnosticsRow.outcome as DashboardRunNodeDiagnosticPayload['status'],
    provider: null,
    timing: {
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      persistedAt: diagnosticsRow.createdAt,
    },
    summary: {
      tokensUsed: 0,
      eventCount: diagnosticsRow.eventCount,
      retainedEventCount: diagnosticsRow.retainedEventCount,
      droppedEventCount: diagnosticsRow.droppedEventCount,
      toolEventCount: 0,
      redacted: diagnosticsRow.redacted === 1,
      truncated: diagnosticsRow.truncated === 1,
    },
    contextHandoff: {},
    eventTypeCounts: {},
    events: [],
    toolEvents: [],
    routingDecision: null,
    error: null,
  };

  const payload = isRecordValue(diagnosticsRow.diagnostics)
    ? (diagnosticsRow.diagnostics as DashboardRunNodeDiagnosticPayload)
    : fallbackPayload;

  return {
    id: diagnosticsRow.id,
    runNodeId: diagnosticsRow.runNodeId,
    attempt: diagnosticsRow.attempt,
    outcome: diagnosticsRow.outcome as DashboardRunNodeDiagnosticsSnapshot['outcome'],
    eventCount: diagnosticsRow.eventCount,
    retainedEventCount: diagnosticsRow.retainedEventCount,
    droppedEventCount: diagnosticsRow.droppedEventCount,
    redacted: diagnosticsRow.redacted === 1,
    truncated: diagnosticsRow.truncated === 1,
    payloadChars: diagnosticsRow.payloadChars,
    createdAt: diagnosticsRow.createdAt,
    diagnostics: payload,
  };
}

export function createRunNodeStreamEventSnapshot(
  row: {
    id: number;
    workflowRunId: number;
    runNodeId: number;
    attempt: number;
    sequence: number;
    eventType: string;
    timestamp: number;
    contentChars: number;
    contentPreview: string;
    metadata: unknown;
    usageDeltaTokens: number | null;
    usageCumulativeTokens: number | null;
    createdAt: string;
  },
): DashboardRunNodeStreamEvent {
  const metadata = isRecordValue(row.metadata) ? row.metadata : null;
  const usage =
    row.usageDeltaTokens !== null || row.usageCumulativeTokens !== null
      ? {
          deltaTokens: row.usageDeltaTokens,
          cumulativeTokens: row.usageCumulativeTokens,
        }
      : null;

  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    runNodeId: row.runNodeId,
    attempt: row.attempt,
    sequence: row.sequence,
    type: row.eventType as DashboardRunNodeStreamEvent['type'],
    timestamp: row.timestamp,
    contentChars: row.contentChars,
    contentPreview: row.contentPreview,
    metadata,
    usage,
    createdAt: row.createdAt,
  };
}

export function toWorktreeMetadata(worktree: {
  id: number;
  workflowRunId: number;
  repositoryId: number;
  worktreePath: string;
  branch: string;
  commitHash: string | null;
  status: string;
  createdAt: string;
  removedAt: string | null;
}): DashboardRunWorktreeMetadata {
  return {
    id: worktree.id,
    runId: worktree.workflowRunId,
    repositoryId: worktree.repositoryId,
    path: worktree.worktreePath,
    branch: worktree.branch,
    commitHash: worktree.commitHash,
    status: worktree.status as DashboardRunWorktreeMetadata['status'],
    createdAt: worktree.createdAt,
    removedAt: worktree.removedAt,
  };
}

export function parseAzureRemoteRef(remoteRef: string): {
  organization: string;
  project: string;
  repository: string;
} {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 3) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Invalid Azure repository reference "${remoteRef}". Expected org/project/repository.`,
      { status: 400 },
    );
  }

  return {
    organization: segments[0],
    project: segments[1],
    repository: segments[2],
  };
}

export function parseGitHubRemoteRef(remoteRef: string): {
  owner: string;
  repository: string;
} {
  const segments = remoteRef
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);

  if (segments.length !== 2) {
    throw new DashboardIntegrationError(
      'invalid_request',
      `Invalid GitHub repository reference "${remoteRef}". Expected owner/repository.`,
      { status: 400 },
    );
  }

  return {
    owner: segments[0],
    repository: segments[1],
  };
}
