import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, listWorkflowRunsMock, launchWorkflowRunMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  listWorkflowRunsMock: vi.fn(),
  launchWorkflowRunMock: vi.fn(),
}));

vi.mock('../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, POST } from './route';

function createJsonRequest(url: string, payload: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function createInvalidJsonRequest(url: string, body: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body,
  });
}

describe('Route /api/dashboard/runs', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    listWorkflowRunsMock.mockReset();
    launchWorkflowRunMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      listWorkflowRuns: listWorkflowRunsMock,
      launchWorkflowRun: launchWorkflowRunMock,
    });
  });

  describe('GET', () => {
    it('uses the default limit when query parameter is omitted', async () => {
      listWorkflowRunsMock.mockResolvedValue([
        {
          id: 1,
        },
      ]);

      const response = await GET(new Request('http://localhost/api/dashboard/runs'));

      expect(listWorkflowRunsMock).toHaveBeenCalledWith(20);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        runs: [
          {
            id: 1,
          },
        ],
      });
    });

    it('accepts a valid limit query parameter', async () => {
      listWorkflowRunsMock.mockResolvedValue([]);

      const response = await GET(new Request('http://localhost/api/dashboard/runs?limit=7'));

      expect(listWorkflowRunsMock).toHaveBeenCalledWith(7);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        runs: [],
      });
    });

    it('returns 400 when the limit query parameter is invalid', async () => {
      const response = await GET(new Request('http://localhost/api/dashboard/runs?limit=0'));

      expect(listWorkflowRunsMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Query parameter "limit" must be a positive integer.',
        },
      });
    });
  });

  describe('POST', () => {
    it('returns 200 for synchronous launches', async () => {
      launchWorkflowRunMock.mockResolvedValue({
        mode: 'sync',
        id: 5,
      });

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
        executionMode: 'sync',
      }));

      expect(launchWorkflowRunMock).toHaveBeenCalledWith({
        treeKey: 'default',
        repositoryName: undefined,
        branch: undefined,
        executionMode: 'sync',
        executionScope: undefined,
        nodeSelector: undefined,
        cleanupWorktree: undefined,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        mode: 'sync',
        id: 5,
      });
    });

    it('returns 202 for asynchronous launches', async () => {
      launchWorkflowRunMock.mockResolvedValue({
        mode: 'async',
        id: 9,
      });

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
        executionMode: 'async',
      }));

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        mode: 'async',
        id: 9,
      });
    });

    it('parses single-node launch payloads with node selectors', async () => {
      launchWorkflowRunMock.mockResolvedValue({
        mode: 'async',
        id: 12,
      });

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
        executionScope: 'single_node',
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'design',
        },
      }));

      expect(launchWorkflowRunMock).toHaveBeenCalledWith({
        treeKey: 'default',
        repositoryName: undefined,
        branch: undefined,
        executionMode: undefined,
        executionScope: 'single_node',
        nodeSelector: {
          type: 'node_key',
          nodeKey: 'design',
        },
        cleanupWorktree: undefined,
      });
      expect(response.status).toBe(202);
    });

    it('parses single-node launch payloads with a next_runnable selector', async () => {
      launchWorkflowRunMock.mockResolvedValue({
        mode: 'async',
        id: 13,
      });

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
        executionScope: 'single_node',
        nodeSelector: {
          type: 'next_runnable',
        },
      }));

      expect(launchWorkflowRunMock).toHaveBeenCalledWith({
        treeKey: 'default',
        repositoryName: undefined,
        branch: undefined,
        executionMode: undefined,
        executionScope: 'single_node',
        nodeSelector: {
          type: 'next_runnable',
        },
        cleanupWorktree: undefined,
      });
      expect(response.status).toBe(202);
    });

    it('returns 400 when request body is not an object', async () => {
      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', null));

      expect(launchWorkflowRunMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message: 'Run launch request body must be an object.',
        },
      });
    });

    it('returns 400 when request body contains malformed JSON', async () => {
      const response = await POST(createInvalidJsonRequest('http://localhost/api/dashboard/runs', '{"treeKey":'));

      expect(launchWorkflowRunMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error.code).toBe('invalid_request');
      expect(typeof payload.error.message).toBe('string');
      expect(payload.error.message.length).toBeGreaterThan(0);
    });

    it.each([
      {
        title: 'treeKey is missing',
        payload: {},
        message: 'Run launch requires string field "treeKey".',
      },
      {
        title: 'repositoryName has an invalid type',
        payload: { treeKey: 'default', repositoryName: 100 },
        message: 'Field "repositoryName" must be a string when provided.',
      },
      {
        title: 'repositoryName is an empty string',
        payload: { treeKey: 'default', repositoryName: '' },
        message: 'Field "repositoryName" cannot be empty when provided.',
      },
      {
        title: 'repositoryName is whitespace only',
        payload: { treeKey: 'default', repositoryName: '   ' },
        message: 'Field "repositoryName" cannot be empty when provided.',
      },
      {
        title: 'branch has an invalid type',
        payload: { treeKey: 'default', branch: false },
        message: 'Field "branch" must be a string when provided.',
      },
      {
        title: 'executionMode has an invalid value',
        payload: { treeKey: 'default', executionMode: 'background' },
        message: 'Field "executionMode" must be "async" or "sync".',
      },
      {
        title: 'cleanupWorktree has an invalid type',
        payload: { treeKey: 'default', cleanupWorktree: 'yes' },
        message: 'Field "cleanupWorktree" must be a boolean when provided.',
      },
      {
        title: 'executionScope has an invalid value',
        payload: { treeKey: 'default', executionScope: 'partial' },
        message: 'Field "executionScope" must be "full" or "single_node".',
      },
      {
        title: 'nodeSelector requires single_node execution scope',
        payload: { treeKey: 'default', nodeSelector: { type: 'next_runnable' } },
        message: 'Field "nodeSelector" requires "executionScope" to be "single_node".',
      },
      {
        title: 'nodeSelector must be an object',
        payload: { treeKey: 'default', executionScope: 'single_node', nodeSelector: 'next_runnable' },
        message: 'Field "nodeSelector" must be an object when provided.',
      },
      {
        title: 'nodeSelector type has an invalid value',
        payload: { treeKey: 'default', executionScope: 'single_node', nodeSelector: { type: 'later' } },
        message: 'Field "nodeSelector.type" must be "next_runnable" or "node_key".',
      },
      {
        title: 'nodeSelector node_key requires nodeKey',
        payload: { treeKey: 'default', executionScope: 'single_node', nodeSelector: { type: 'node_key' } },
        message: 'Field "nodeSelector.nodeKey" must be a string when nodeSelector.type is "node_key".',
      },
      {
        title: 'nodeSelector node_key cannot be empty',
        payload: {
          treeKey: 'default',
          executionScope: 'single_node',
          nodeSelector: { type: 'node_key', nodeKey: '   ' },
        },
        message: 'Field "nodeSelector.nodeKey" cannot be empty when nodeSelector.type is "node_key".',
      },
    ])('returns 400 when $title', async ({ payload, message }) => {
      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', payload));

      expect(launchWorkflowRunMock).not.toHaveBeenCalled();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_request',
          message,
        },
      });
    });

    it('maps service failures to integration error responses', async () => {
      launchWorkflowRunMock.mockRejectedValue(new Error('launch failed'));

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
      }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'internal_error',
          message: 'Dashboard integration request failed.',
          details: {
            cause: 'launch failed',
          },
        },
      });
    });

    it('returns guided remediation when launch fails with an existing branch conflict', async () => {
      launchWorkflowRunMock.mockRejectedValue(new Error("fatal: a branch named 'main' already exists"));

      const response = await POST(createJsonRequest('http://localhost/api/dashboard/runs', {
        treeKey: 'default',
        branch: 'main',
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'conflict',
          message:
            'Branch "main" already exists. Choose a different branch name, or leave Branch empty to let Alphred generate one.',
        },
      });
    });
  });
});
