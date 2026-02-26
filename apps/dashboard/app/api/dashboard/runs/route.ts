import { NextResponse } from 'next/server';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../src/server/dashboard-service';
import type { DashboardRunLaunchRequest } from '../../../../src/server/dashboard-contracts';

function throwInvalidRequest(message: string): never {
  throw new DashboardIntegrationError('invalid_request', message, {
    status: 400,
  });
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return 20;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throwInvalidRequest('Query parameter "limit" must be a positive integer.');
  }

  return parsed;
}

function parseRequestObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throwInvalidRequest('Run launch request body must be an object.');
  }
  return payload as Record<string, unknown>;
}

function parseTreeKey(candidate: Record<string, unknown>): string {
  const treeKeyValue = candidate.treeKey;
  if (typeof treeKeyValue !== 'string') {
    throwInvalidRequest('Run launch requires string field "treeKey".');
  }
  return treeKeyValue;
}

function parseRepositoryName(candidate: Record<string, unknown>): string | undefined {
  const repositoryNameValue = candidate.repositoryName;
  if (repositoryNameValue !== undefined && typeof repositoryNameValue !== 'string') {
    throwInvalidRequest('Field "repositoryName" must be a string when provided.');
  }
  if (typeof repositoryNameValue === 'string' && repositoryNameValue.trim().length === 0) {
    throwInvalidRequest('Field "repositoryName" cannot be empty when provided.');
  }
  return repositoryNameValue;
}

function parseBranch(candidate: Record<string, unknown>): string | undefined {
  const branchValue = candidate.branch;
  if (branchValue !== undefined && typeof branchValue !== 'string') {
    throwInvalidRequest('Field "branch" must be a string when provided.');
  }
  return branchValue;
}

function parseExecutionMode(
  candidate: Record<string, unknown>,
): DashboardRunLaunchRequest['executionMode'] {
  const executionModeValue = candidate.executionMode;
  if (executionModeValue !== undefined && executionModeValue !== 'async' && executionModeValue !== 'sync') {
    throwInvalidRequest('Field "executionMode" must be "async" or "sync".');
  }
  return executionModeValue;
}

function parseExecutionScope(
  candidate: Record<string, unknown>,
): DashboardRunLaunchRequest['executionScope'] {
  const executionScopeValue = candidate.executionScope;
  if (executionScopeValue !== undefined && executionScopeValue !== 'full' && executionScopeValue !== 'single_node') {
    throwInvalidRequest('Field "executionScope" must be "full" or "single_node".');
  }
  return executionScopeValue;
}

function parseNodeSelector(
  candidate: Record<string, unknown>,
  executionScope: DashboardRunLaunchRequest['executionScope'],
): DashboardRunLaunchRequest['nodeSelector'] {
  const nodeSelectorValue = candidate.nodeSelector;
  if (nodeSelectorValue === undefined) {
    return undefined;
  }

  if (typeof nodeSelectorValue !== 'object' || nodeSelectorValue === null) {
    throwInvalidRequest('Field "nodeSelector" must be an object when provided.');
  }

  if (executionScope !== 'single_node') {
    throwInvalidRequest('Field "nodeSelector" requires "executionScope" to be "single_node".');
  }

  const selectorCandidate = nodeSelectorValue as Record<string, unknown>;
  const selectorTypeValue = selectorCandidate.type;
  if (selectorTypeValue === 'next_runnable') {
    return {
      type: 'next_runnable',
    };
  }

  if (selectorTypeValue !== 'node_key') {
    throwInvalidRequest('Field "nodeSelector.type" must be "next_runnable" or "node_key".');
  }

  if (typeof selectorCandidate.nodeKey !== 'string') {
    throwInvalidRequest('Field "nodeSelector.nodeKey" must be a string when nodeSelector.type is "node_key".');
  }

  const nodeKeyValue = selectorCandidate.nodeKey.trim();
  if (nodeKeyValue.length === 0) {
    throwInvalidRequest('Field "nodeSelector.nodeKey" cannot be empty when nodeSelector.type is "node_key".');
  }

  return {
    type: 'node_key',
    nodeKey: nodeKeyValue,
  };
}

function parseCleanupWorktree(candidate: Record<string, unknown>): boolean | undefined {
  const cleanupWorktreeValue = candidate.cleanupWorktree;
  if (cleanupWorktreeValue !== undefined && typeof cleanupWorktreeValue !== 'boolean') {
    throwInvalidRequest('Field "cleanupWorktree" must be a boolean when provided.');
  }
  return cleanupWorktreeValue;
}

function parseLaunchRequest(payload: unknown): DashboardRunLaunchRequest {
  const candidate = parseRequestObject(payload);
  const treeKey = parseTreeKey(candidate);
  const repositoryName = parseRepositoryName(candidate);
  const branch = parseBranch(candidate);
  const executionMode = parseExecutionMode(candidate);
  const executionScope = parseExecutionScope(candidate);
  const nodeSelector = parseNodeSelector(candidate, executionScope);
  const cleanupWorktree = parseCleanupWorktree(candidate);

  return {
    treeKey,
    repositoryName,
    branch,
    executionMode,
    executionScope,
    nodeSelector,
    cleanupWorktree,
  };
}

export async function GET(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get('limit'));
    const runs = await service.listWorkflowRuns(limit);
    return NextResponse.json({ runs });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const service = createDashboardService();

  try {
    const payload: unknown = await request.json();
    const launchRequest = parseLaunchRequest(payload);
    const result = await service.launchWorkflowRun(launchRequest);
    const status = result.mode === 'async' ? 202 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
