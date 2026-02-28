import { describe, expect, it } from 'vitest';
import { hasPotentialIncomingRoute, hasRunnableIncomingRoute } from './node-selection.js';
import type { EdgeRow, RunNodeExecutionRow } from './types.js';

function createRunNode(overrides: Partial<RunNodeExecutionRow>): RunNodeExecutionRow {
  return {
    runNodeId: 1,
    treeNodeId: 1,
    nodeKey: 'node',
    nodeRole: 'standard',
    status: 'pending',
    sequenceIndex: 1,
    sequencePath: '1',
    lineageDepth: 0,
    spawnerNodeId: null,
    joinNodeId: null,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    maxChildren: 0,
    maxRetries: 0,
    nodeType: 'agent',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    executionPermissions: null,
    errorHandlerConfig: null,
    prompt: 'prompt',
    promptContentType: 'markdown',
    ...overrides,
  };
}

function createEdge(overrides: Partial<EdgeRow>): EdgeRow {
  return {
    edgeId: 1,
    sourceNodeId: 1,
    targetNodeId: 2,
    routeOn: 'success',
    priority: 0,
    edgeKind: 'tree',
    auto: 1,
    guardExpression: null,
    ...overrides,
  };
}

describe('node selection fan-out semantics', () => {
  it('treats dynamic spawner->child success edges as runnable even when not selected as a single route', () => {
    const source = createRunNode({
      runNodeId: 100,
      nodeKey: 'breakdown',
      nodeRole: 'spawner',
      status: 'completed',
    });
    const target = createRunNode({
      runNodeId: 200,
      nodeKey: 'work-item-2',
      status: 'pending',
    });
    const edge = createEdge({
      edgeId: 501,
      sourceNodeId: source.runNodeId,
      targetNodeId: target.runNodeId,
      routeOn: 'success',
      edgeKind: 'dynamic_spawner_to_child',
      priority: 1,
    });

    const latestByNodeId = new Map<number, RunNodeExecutionRow>([
      [source.runNodeId, source],
      [target.runNodeId, target],
    ]);
    const selectedEdgeBySourceNodeId = new Map<number, number>();

    expect(
      hasRunnableIncomingRoute(
        [edge],
        latestByNodeId,
        selectedEdgeBySourceNodeId,
      ),
    ).toBe(true);
    expect(
      hasPotentialIncomingRoute(
        [edge],
        latestByNodeId,
        selectedEdgeBySourceNodeId,
        new Set<number>(),
      ),
    ).toBe(true);
  });

  it('still requires route selection for regular success edges from completed sources', () => {
    const source = createRunNode({
      runNodeId: 300,
      nodeKey: 'review',
      status: 'completed',
    });
    const target = createRunNode({
      runNodeId: 400,
      nodeKey: 'implement',
      status: 'pending',
    });
    const edge = createEdge({
      edgeId: 601,
      sourceNodeId: source.runNodeId,
      targetNodeId: target.runNodeId,
      routeOn: 'success',
      edgeKind: 'tree',
    });

    const latestByNodeId = new Map<number, RunNodeExecutionRow>([
      [source.runNodeId, source],
      [target.runNodeId, target],
    ]);
    const selectedEdgeBySourceNodeId = new Map<number, number>();

    expect(
      hasRunnableIncomingRoute(
        [edge],
        latestByNodeId,
        selectedEdgeBySourceNodeId,
      ),
    ).toBe(false);
    expect(
      hasPotentialIncomingRoute(
        [edge],
        latestByNodeId,
        selectedEdgeBySourceNodeId,
        new Set<number>(),
      ),
    ).toBe(false);
  });
});
