import { describe, expect, it } from 'vitest';
import { getLatestRunNodeAttempts } from './type-conversions.js';
import type { RunNodeExecutionRow } from './types.js';

function createRunNodeRow(overrides: Partial<RunNodeExecutionRow>): RunNodeExecutionRow {
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

describe('getLatestRunNodeAttempts', () => {
  it('keeps distinct run nodes even when node keys collide', () => {
    const rows: RunNodeExecutionRow[] = [
      createRunNodeRow({
        runNodeId: 12,
        treeNodeId: 101,
        nodeKey: 'shared-child',
        sequenceIndex: 10,
      }),
      createRunNodeRow({
        runNodeId: 11,
        treeNodeId: 100,
        nodeKey: 'shared-child',
        sequenceIndex: 10,
      }),
    ];

    const latest = getLatestRunNodeAttempts(rows);

    expect(latest).toHaveLength(2);
    expect(latest.map(row => row.runNodeId)).toEqual([11, 12]);
  });

  it('retains only the highest attempt for duplicate logical run-node rows', () => {
    const rows: RunNodeExecutionRow[] = [
      createRunNodeRow({
        runNodeId: 22,
        treeNodeId: 5,
        nodeKey: 'design',
        attempt: 1,
      }),
      createRunNodeRow({
        runNodeId: 23,
        treeNodeId: 5,
        nodeKey: 'design',
        attempt: 2,
        status: 'completed',
      }),
      createRunNodeRow({
        runNodeId: 24,
        treeNodeId: 6,
        nodeKey: 'other-node',
        sequenceIndex: 2,
      }),
    ];

    const latest = getLatestRunNodeAttempts(rows);

    expect(latest).toHaveLength(2);
    expect(latest.find(row => row.nodeKey === 'design')?.runNodeId).toBe(23);
    expect(latest.map(row => row.runNodeId)).toEqual([23, 24]);
  });

  it('keeps dynamic children distinct when they share a tree node id with their spawner', () => {
    const rows: RunNodeExecutionRow[] = [
      createRunNodeRow({
        runNodeId: 40,
        treeNodeId: 8,
        nodeKey: 'breakdown',
        sequenceIndex: 1,
      }),
      createRunNodeRow({
        runNodeId: 41,
        treeNodeId: 8,
        nodeKey: 'child-a',
        sequenceIndex: 2,
        spawnerNodeId: 40,
        joinNodeId: 50,
      }),
      createRunNodeRow({
        runNodeId: 42,
        treeNodeId: 8,
        nodeKey: 'child-a',
        sequenceIndex: 2,
        spawnerNodeId: 40,
        joinNodeId: 50,
        attempt: 2,
      }),
      createRunNodeRow({
        runNodeId: 43,
        treeNodeId: 8,
        nodeKey: 'child-b',
        sequenceIndex: 3,
        spawnerNodeId: 40,
        joinNodeId: 50,
      }),
    ];

    const latest = getLatestRunNodeAttempts(rows);

    expect(latest).toHaveLength(3);
    expect(latest.map(row => row.runNodeId)).toEqual([40, 42, 43]);
  });
});
