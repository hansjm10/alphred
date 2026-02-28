import { describe, expect, it } from 'vitest';
import { resolveCompletedNodeRoutingOutcome } from './persistence.js';
import type { EdgeRow } from './types.js';

function createEdgeRow(params: {
  edgeId: number;
  sourceNodeId: number;
  targetNodeId: number;
  routeOn: EdgeRow['routeOn'];
  edgeKind: EdgeRow['edgeKind'];
  auto: number;
  priority: number;
  guardExpression: unknown;
}): EdgeRow {
  return {
    edgeId: params.edgeId,
    sourceNodeId: params.sourceNodeId,
    targetNodeId: params.targetNodeId,
    routeOn: params.routeOn,
    priority: params.priority,
    edgeKind: params.edgeKind,
    auto: params.auto,
    guardExpression: params.guardExpression,
  };
}

describe('resolveCompletedNodeRoutingOutcome', () => {
  it('does not let dynamic fan-out success edges bypass guarded routing', () => {
    const runNodeId = 10;
    const edgeRows: EdgeRow[] = [
      createEdgeRow({
        edgeId: 1,
        sourceNodeId: runNodeId,
        targetNodeId: 11,
        routeOn: 'success',
        edgeKind: 'dynamic_spawner_to_child',
        auto: 1,
        priority: 0,
        guardExpression: null,
      }),
      createEdgeRow({
        edgeId: 2,
        sourceNodeId: runNodeId,
        targetNodeId: 12,
        routeOn: 'success',
        edgeKind: 'tree',
        auto: 0,
        priority: 1,
        guardExpression: {
          field: 'decision',
          operator: '==',
          value: 'approved',
        },
      }),
    ];

    const outcome = resolveCompletedNodeRoutingOutcome({
      runNodeId,
      routingDecision: null,
      edgeRows,
    });

    expect(outcome).toEqual({
      decisionType: 'no_route',
      selectedEdgeId: null,
    });
  });

  it('selects a matching static tree success edge even when dynamic edges exist', () => {
    const runNodeId = 20;
    const edgeRows: EdgeRow[] = [
      createEdgeRow({
        edgeId: 1,
        sourceNodeId: runNodeId,
        targetNodeId: 21,
        routeOn: 'success',
        edgeKind: 'dynamic_spawner_to_child',
        auto: 1,
        priority: 0,
        guardExpression: null,
      }),
      createEdgeRow({
        edgeId: 2,
        sourceNodeId: runNodeId,
        targetNodeId: 22,
        routeOn: 'success',
        edgeKind: 'tree',
        auto: 0,
        priority: 1,
        guardExpression: {
          field: 'decision',
          operator: '==',
          value: 'approved',
        },
      }),
      createEdgeRow({
        edgeId: 3,
        sourceNodeId: runNodeId,
        targetNodeId: 23,
        routeOn: 'success',
        edgeKind: 'tree',
        auto: 0,
        priority: 2,
        guardExpression: {
          field: 'decision',
          operator: '==',
          value: 'changes_requested',
        },
      }),
    ];

    const outcome = resolveCompletedNodeRoutingOutcome({
      runNodeId,
      routingDecision: 'approved',
      edgeRows,
    });

    expect(outcome).toEqual({
      decisionType: 'approved',
      selectedEdgeId: 2,
    });
  });
});
