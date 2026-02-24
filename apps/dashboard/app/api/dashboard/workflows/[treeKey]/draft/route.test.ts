import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDashboardServiceMock, getOrCreateWorkflowDraftMock, saveWorkflowDraftMock } = vi.hoisted(() => ({
  createDashboardServiceMock: vi.fn(),
  getOrCreateWorkflowDraftMock: vi.fn(),
  saveWorkflowDraftMock: vi.fn(),
}));

vi.mock('../../../../../../src/server/dashboard-service', () => ({
  createDashboardService: createDashboardServiceMock,
}));

import { GET, PUT } from './route';

describe('GET /api/dashboard/workflows/[treeKey]/draft', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getOrCreateWorkflowDraftMock.mockReset();
    saveWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getOrCreateWorkflowDraft: getOrCreateWorkflowDraftMock,
      saveWorkflowDraft: saveWorkflowDraftMock,
    });
  });

  it('returns the workflow draft topology from the dashboard service', async () => {
    getOrCreateWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 2,
      draftRevision: 0,
      name: 'Demo Tree',
      description: null,
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/demo-tree/draft'), {
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: {
        treeKey: 'demo-tree',
        version: 2,
        draftRevision: 0,
        name: 'Demo Tree',
        description: null,
        versionNotes: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
    });
    expect(getOrCreateWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });

  it('maps service failures to integration error responses', async () => {
    getOrCreateWorkflowDraftMock.mockRejectedValue(new Error('load failed'));

    const response = await GET(new Request('http://localhost/api/dashboard/workflows/demo-tree/draft'), {
      params: Promise.resolve({ treeKey: 'demo-tree' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'load failed',
        },
      },
    });
  });
});

describe('PUT /api/dashboard/workflows/[treeKey]/draft', () => {
  beforeEach(() => {
    createDashboardServiceMock.mockReset();
    getOrCreateWorkflowDraftMock.mockReset();
    saveWorkflowDraftMock.mockReset();
    createDashboardServiceMock.mockReturnValue({
      getOrCreateWorkflowDraft: getOrCreateWorkflowDraftMock,
      saveWorkflowDraft: saveWorkflowDraftMock,
    });
  });

  it('returns 400 when version query param is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=0', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRevision: 0, name: 'Demo', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Query parameter "version" must be a positive integer.',
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when draft payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRevision: 1, name: 123, nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft name must be a string.',
        details: {
          field: 'name',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when nodes payload is not an array', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRevision: 1, name: 'Demo', nodes: 'nope', edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft nodes must be an array.',
        details: { field: 'nodes' },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'invalid',
            provider: null,
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid nodeType.',
        details: {
          field: 'nodes[0].nodeType',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node position payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: null,
            maxRetries: 0,
            sequenceIndex: 10,
            position: { x: 'nope', y: 2 },
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid position.',
        details: {
          field: 'nodes[0].position',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node provider payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 123,
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid provider.',
        details: {
          field: 'nodes[0].provider',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node maxRetries payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: null,
            maxRetries: -1,
            sequenceIndex: 10,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid maxRetries.',
        details: {
          field: 'nodes[0].maxRetries',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node sequenceIndex payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: null,
            maxRetries: 0,
            sequenceIndex: 'nope',
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid sequenceIndex.',
        details: {
          field: 'nodes[0].sequenceIndex',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node sequenceIndex is negative', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: null,
            maxRetries: 0,
            sequenceIndex: -1,
            position: null,
            promptTemplate: null,
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid sequenceIndex.',
        details: {
          field: 'nodes[0].sequenceIndex',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when a node promptTemplate payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: null,
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 123, contentType: 'markdown' },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has an invalid promptTemplate.',
        details: {
          field: 'nodes[0].promptTemplate',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when node executionPermissions payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: { sandboxMode: 'invalid-mode' },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has invalid executionPermissions.sandboxMode.',
        details: {
          field: 'nodes[0].executionPermissions.sandboxMode',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when node executionPermissions includes unsupported fields', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {
              sandboxMode: 'workspace-write',
              unexpected: true,
            },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has unsupported executionPermissions field "unexpected".',
        details: {
          field: 'nodes[0].executionPermissions.unexpected',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when node executionPermissions.networkAccessEnabled is not boolean', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {
              networkAccessEnabled: 'true',
            },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has invalid executionPermissions.networkAccessEnabled.',
        details: {
          field: 'nodes[0].executionPermissions.networkAccessEnabled',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when node executionPermissions.additionalDirectories includes non-string items', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {
              additionalDirectories: ['/tmp/cache', 42],
            },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has invalid executionPermissions.additionalDirectories.',
        details: {
          field: 'nodes[0].executionPermissions.additionalDirectories',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when node executionPermissions.webSearchMode is unsupported', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: null,
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {
              webSearchMode: 'sometimes',
            },
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft node at index 0 has invalid executionPermissions.webSearchMode.',
        details: {
          field: 'nodes[0].executionPermissions.webSearchMode',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when an edge payload is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [],
        edges: [
          {
            sourceNodeKey: 'design',
            targetNodeKey: 'implement',
            priority: 1.5,
            auto: true,
          },
        ],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft edge at index 0 must have an integer priority.',
        details: {
          field: 'edges[0].priority',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('returns 400 when edge auto flag is invalid', async () => {
    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 1,
        name: 'Demo Tree',
        nodes: [],
        edges: [
          {
            sourceNodeKey: 'design',
            targetNodeKey: 'implement',
            priority: 100,
            auto: 'true',
          },
        ],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_request',
        message: 'Draft edge at index 0 must have a boolean auto flag.',
        details: {
          field: 'edges[0].auto',
        },
      },
    });
    expect(saveWorkflowDraftMock).not.toHaveBeenCalled();
  });

  it('saves workflow drafts via the dashboard service', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 3,
      draftRevision: 1,
      name: 'Demo Tree',
      description: null,
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=3', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRevision: 1, name: 'Demo Tree', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: {
        treeKey: 'demo-tree',
        version: 3,
        draftRevision: 1,
        name: 'Demo Tree',
        description: null,
        versionNotes: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
    });
    expect(saveWorkflowDraftMock).toHaveBeenCalledTimes(1);
  });

  it('accepts node and edge payloads when saving drafts', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 1,
      draftRevision: 2,
      name: 'Demo Tree',
      description: 'Demo description',
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 2,
        name: 'Demo Tree',
        description: 'Demo description',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: { x: 10, y: 20 },
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {
              approvalPolicy: 'on-request',
              sandboxMode: 'workspace-write',
              networkAccessEnabled: true,
              additionalDirectories: ['/tmp/scratch'],
              webSearchMode: 'cached',
            },
          },
        ],
        edges: [
          {
            sourceNodeKey: 'design',
            targetNodeKey: 'design',
            priority: 100,
            auto: false,
            guardExpression: { field: 'decision', operator: '==', value: 'approved' },
          },
        ],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: {
        treeKey: 'demo-tree',
        version: 1,
        draftRevision: 2,
        name: 'Demo Tree',
        description: 'Demo description',
        versionNotes: null,
        nodes: [],
        edges: [],
        initialRunnableNodeKeys: [],
      },
    });
    expect(saveWorkflowDraftMock).toHaveBeenCalledTimes(1);
    expect(saveWorkflowDraftMock).toHaveBeenCalledWith('demo-tree', 1, expect.objectContaining({
      nodes: [
        expect.objectContaining({
          executionPermissions: {
            approvalPolicy: 'on-request',
            sandboxMode: 'workspace-write',
            networkAccessEnabled: true,
            additionalDirectories: ['/tmp/scratch'],
            webSearchMode: 'cached',
          },
        }),
      ],
    }));
  });

  it('drops empty executionPermissions objects when saving drafts', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 1,
      draftRevision: 2,
      name: 'Demo Tree',
      description: null,
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 2,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: { x: 10, y: 20 },
            promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
            executionPermissions: {},
          },
        ],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    expect(saveWorkflowDraftMock).toHaveBeenCalledWith('demo-tree', 1, expect.objectContaining({
      nodes: [
        expect.not.objectContaining({
          executionPermissions: expect.anything(),
        }),
      ],
    }));
  });

  it('defaults missing guardExpression fields to null when saving drafts', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 1,
      draftRevision: 3,
      name: 'Demo Tree',
      description: null,
      versionNotes: null,
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 3,
        name: 'Demo Tree',
        nodes: [
          {
            nodeKey: 'design',
            displayName: 'Design',
            nodeType: 'agent',
            provider: 'codex',
            maxRetries: 0,
            sequenceIndex: 10,
            position: { x: 10, y: 20 },
            promptTemplate: { content: 'Draft prompt', contentType: 'text' },
          },
        ],
        edges: [
          {
            sourceNodeKey: 'design',
            targetNodeKey: 'design',
            priority: 100,
            auto: false,
          },
        ],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    expect(saveWorkflowDraftMock).toHaveBeenCalledWith('demo-tree', 1, {
      draftRevision: 3,
      name: 'Demo Tree',
      nodes: [
        {
          nodeKey: 'design',
          displayName: 'Design',
          nodeType: 'agent',
          provider: 'codex',
          model: null,
          maxRetries: 0,
          sequenceIndex: 10,
          position: { x: 10, y: 20 },
          promptTemplate: { content: 'Draft prompt', contentType: 'text' },
        },
      ],
      edges: [
        {
          sourceNodeKey: 'design',
          targetNodeKey: 'design',
          priority: 100,
          auto: false,
          guardExpression: null,
        },
      ],
    });
  });

  it('includes versionNotes when saving drafts', async () => {
    saveWorkflowDraftMock.mockResolvedValue({
      treeKey: 'demo-tree',
      version: 1,
      draftRevision: 4,
      name: 'Demo Tree',
      description: null,
      versionNotes: 'Notes',
      nodes: [],
      edges: [],
      initialRunnableNodeKeys: [],
    });

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRevision: 4,
        name: 'Demo Tree',
        versionNotes: 'Notes',
        nodes: [],
        edges: [],
      }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });

    expect(response.status).toBe(200);
    expect(saveWorkflowDraftMock).toHaveBeenCalledWith('demo-tree', 1, {
      draftRevision: 4,
      name: 'Demo Tree',
      versionNotes: 'Notes',
      nodes: [],
      edges: [],
    });
  });

  it('maps service failures to integration error responses', async () => {
    saveWorkflowDraftMock.mockRejectedValue(new Error('save failed'));

    const request = new Request('http://localhost/api/dashboard/workflows/demo-tree/draft?version=1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRevision: 1, name: 'Demo Tree', nodes: [], edges: [] }),
    });

    const response = await PUT(request, { params: Promise.resolve({ treeKey: 'demo-tree' }) });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Dashboard integration request failed.',
        details: {
          cause: 'save failed',
        },
      },
    });
  });
});
