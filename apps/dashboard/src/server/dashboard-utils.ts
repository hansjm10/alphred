import { resolve } from 'node:path';
import { WorkflowRunControlError } from '@alphred/core';
import type {
  DashboardNodeStatus,
  DashboardNodeStatusSummary,
  DashboardRunNodeSnapshot,
  DashboardRunSummary,
} from './dashboard-contracts';
import { DashboardIntegrationError } from './dashboard-errors';

export type RunStatus = DashboardRunSummary['status'];

function parseDashboardNodeRole(value: string): DashboardRunNodeSnapshot['nodeRole'] {
  if (value === 'standard' || value === 'spawner' || value === 'join') {
    return value;
  }

  throw new DashboardIntegrationError('internal_error', `Unsupported run node role "${value}".`, {
    status: 500,
  });
}

export function resolveDatabasePath(environment: NodeJS.ProcessEnv, cwd: string): string {
  const configuredPath = environment.ALPHRED_DB_PATH?.trim();
  if (configuredPath && configuredPath.length > 0) {
    return resolve(cwd, configuredPath);
  }

  return resolve(cwd, 'alphred.db');
}

export function summarizeNodeStatuses(nodes: readonly { status: DashboardNodeStatus }[]): DashboardNodeStatusSummary {
  const summary: DashboardNodeStatusSummary = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };

  for (const node of nodes) {
    summary[node.status] += 1;
  }

  return summary;
}

export function selectLatestNodeAttempts(
  nodes: readonly {
    id: number;
    nodeKey: string;
    nodeRole: string;
    spawnerNodeId: number | null;
    joinNodeId: number | null;
    lineageDepth: number;
    sequencePath: string | null;
    attempt: number;
    sequenceIndex: number;
    treeNodeId: number;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  }[],
): DashboardRunNodeSnapshot[] {
  const latestByNodeKey = new Map<string, (typeof nodes)[number]>();
  for (const node of nodes) {
    const current = latestByNodeKey.get(node.nodeKey);
    if (!current || node.attempt > current.attempt || (node.attempt === current.attempt && node.id > current.id)) {
      latestByNodeKey.set(node.nodeKey, node);
    }
  }

  return [...latestByNodeKey.values()]
    .sort((left, right) => {
      if (left.sequenceIndex !== right.sequenceIndex) {
        return left.sequenceIndex - right.sequenceIndex;
      }
      if (left.nodeKey < right.nodeKey) {
        return -1;
      }
      if (left.nodeKey > right.nodeKey) {
        return 1;
      }
      return left.id - right.id;
    })
    .map(node => ({
      id: node.id,
      treeNodeId: node.treeNodeId,
      nodeKey: node.nodeKey,
      nodeRole: parseDashboardNodeRole(node.nodeRole),
      spawnerNodeId: node.spawnerNodeId,
      joinNodeId: node.joinNodeId,
      lineageDepth: node.lineageDepth,
      sequencePath: node.sequencePath,
      sequenceIndex: node.sequenceIndex,
      attempt: node.attempt,
      status: node.status as DashboardNodeStatus,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      latestArtifact: null,
      latestRoutingDecision: null,
      latestDiagnostics: null,
    }));
}

export function isTerminalNodeStatus(status: DashboardNodeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled';
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isWorkflowRunTransitionPreconditionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('precondition failed');
}

export function toBackgroundFailureTransition(
  status: RunStatus,
): { expectedFrom: 'pending' | 'running' | 'paused'; to: 'cancelled' | 'failed' } | null {
  if (status === 'pending') {
    return {
      expectedFrom: 'pending',
      to: 'cancelled',
    };
  }

  if (status === 'running') {
    return {
      expectedFrom: 'running',
      to: 'failed',
    };
  }

  if (status === 'paused') {
    return {
      expectedFrom: 'paused',
      to: 'cancelled',
    };
  }

  return null;
}

export function toDashboardRunControlConflictError(error: WorkflowRunControlError): DashboardIntegrationError {
  return new DashboardIntegrationError('conflict', error.message, {
    status: 409,
    details: {
      controlCode: error.code,
      action: error.action,
      workflowRunId: error.workflowRunId,
      runStatus: error.runStatus,
    },
    cause: error,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
