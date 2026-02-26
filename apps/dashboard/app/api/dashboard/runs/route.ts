import { NextResponse } from 'next/server';
import { DashboardIntegrationError } from '../../../../src/server/dashboard-errors';
import { toErrorResponse } from '../../../../src/server/dashboard-http';
import { createDashboardService } from '../../../../src/server/dashboard-service';
import type { DashboardRunLaunchRequest } from '../../../../src/server/dashboard-contracts';

function parseLimit(value: string | null): number {
  if (value === null) {
    return 20;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DashboardIntegrationError('invalid_request', 'Query parameter "limit" must be a positive integer.', {
      status: 400,
    });
  }

  return parsed;
}

function parseLaunchRequest(payload: unknown): DashboardRunLaunchRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new DashboardIntegrationError('invalid_request', 'Run launch request body must be an object.', {
      status: 400,
    });
  }

  const candidate = payload as Record<string, unknown>;
  const treeKeyValue = candidate.treeKey;
  if (typeof treeKeyValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Run launch requires string field "treeKey".', {
      status: 400,
    });
  }

  const repositoryNameValue = candidate.repositoryName;
  if (repositoryNameValue !== undefined && typeof repositoryNameValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Field "repositoryName" must be a string when provided.', {
      status: 400,
    });
  }
  if (typeof repositoryNameValue === 'string' && repositoryNameValue.trim().length === 0) {
    throw new DashboardIntegrationError('invalid_request', 'Field "repositoryName" cannot be empty when provided.', {
      status: 400,
    });
  }

  const branchValue = candidate.branch;
  if (branchValue !== undefined && typeof branchValue !== 'string') {
    throw new DashboardIntegrationError('invalid_request', 'Field "branch" must be a string when provided.', {
      status: 400,
    });
  }

  const executionModeValue = candidate.executionMode;
  if (executionModeValue !== undefined && executionModeValue !== 'async' && executionModeValue !== 'sync') {
    throw new DashboardIntegrationError('invalid_request', 'Field "executionMode" must be "async" or "sync".', {
      status: 400,
    });
  }

  const executionScopeValue = candidate.executionScope;
  if (executionScopeValue !== undefined && executionScopeValue !== 'full' && executionScopeValue !== 'single_node') {
    throw new DashboardIntegrationError('invalid_request', 'Field "executionScope" must be "full" or "single_node".', {
      status: 400,
    });
  }

  const nodeSelectorValue = candidate.nodeSelector;
  let nodeSelector: DashboardRunLaunchRequest['nodeSelector'];
  if (nodeSelectorValue !== undefined) {
    if (typeof nodeSelectorValue !== 'object' || nodeSelectorValue === null) {
      throw new DashboardIntegrationError('invalid_request', 'Field "nodeSelector" must be an object when provided.', {
        status: 400,
      });
    }

    if (executionScopeValue !== 'single_node') {
      throw new DashboardIntegrationError(
        'invalid_request',
        'Field "nodeSelector" requires "executionScope" to be "single_node".',
        {
          status: 400,
        },
      );
    }

    const selectorCandidate = nodeSelectorValue as Record<string, unknown>;
    const selectorTypeValue = selectorCandidate.type;
    if (selectorTypeValue === 'next_runnable') {
      nodeSelector = { type: 'next_runnable' };
    } else if (selectorTypeValue === 'node_key') {
      if (typeof selectorCandidate.nodeKey !== 'string') {
        throw new DashboardIntegrationError(
          'invalid_request',
          'Field "nodeSelector.nodeKey" must be a string when nodeSelector.type is "node_key".',
          {
            status: 400,
          },
        );
      }
      const nodeKeyValue = selectorCandidate.nodeKey.trim();
      if (nodeKeyValue.length === 0) {
        throw new DashboardIntegrationError(
          'invalid_request',
          'Field "nodeSelector.nodeKey" cannot be empty when nodeSelector.type is "node_key".',
          {
            status: 400,
          },
        );
      }
      nodeSelector = {
        type: 'node_key',
        nodeKey: nodeKeyValue,
      };
    } else {
      throw new DashboardIntegrationError(
        'invalid_request',
        'Field "nodeSelector.type" must be "next_runnable" or "node_key".',
        {
          status: 400,
        },
      );
    }
  }

  const cleanupWorktreeValue = candidate.cleanupWorktree;
  if (cleanupWorktreeValue !== undefined && typeof cleanupWorktreeValue !== 'boolean') {
    throw new DashboardIntegrationError('invalid_request', 'Field "cleanupWorktree" must be a boolean when provided.', {
      status: 400,
    });
  }

  return {
    treeKey: treeKeyValue,
    repositoryName: repositoryNameValue,
    branch: branchValue,
    executionMode: executionModeValue,
    executionScope: executionScopeValue,
    nodeSelector,
    cleanupWorktree: cleanupWorktreeValue,
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
