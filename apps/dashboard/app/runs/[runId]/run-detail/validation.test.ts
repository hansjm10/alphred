import { describe, expect, it } from 'vitest';
import type { DashboardRunDetail } from '../../../../src/server/dashboard-contracts';
import { hasFanOutGroupShape, hasRunNodeShape } from './validation';

function createRunNode(
  overrides: Partial<DashboardRunDetail['nodes'][number]> = {},
): DashboardRunDetail['nodes'][number] {
  return {
    id: overrides.id ?? 10,
    treeNodeId: overrides.treeNodeId ?? 20,
    nodeKey: overrides.nodeKey ?? 'draft',
    nodeRole: overrides.nodeRole ?? 'standard',
    spawnerNodeId: overrides.spawnerNodeId ?? null,
    joinNodeId: overrides.joinNodeId ?? null,
    lineageDepth: overrides.lineageDepth ?? 0,
    sequencePath: overrides.sequencePath ?? null,
    sequenceIndex: overrides.sequenceIndex ?? 1,
    attempt: overrides.attempt ?? 1,
    status: overrides.status ?? 'pending',
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    latestArtifact: overrides.latestArtifact ?? null,
    latestRoutingDecision: overrides.latestRoutingDecision ?? null,
    latestDiagnostics: overrides.latestDiagnostics ?? null,
  };
}

function createFanOutGroup(
  overrides: Partial<DashboardRunDetail['fanOutGroups'][number]> = {},
): DashboardRunDetail['fanOutGroups'][number] {
  return {
    spawnerNodeId: overrides.spawnerNodeId ?? 1,
    joinNodeId: overrides.joinNodeId ?? 2,
    spawnSourceArtifactId: overrides.spawnSourceArtifactId ?? 99,
    expectedChildren: overrides.expectedChildren ?? 2,
    terminalChildren: overrides.terminalChildren ?? 1,
    completedChildren: overrides.completedChildren ?? 1,
    failedChildren: overrides.failedChildren ?? 0,
    status: overrides.status ?? 'pending',
    childNodeIds: overrides.childNodeIds ?? [11],
  };
}

describe('run-detail validation helpers', () => {
  describe('hasRunNodeShape', () => {
    it('accepts standard root and linked fan-out child nodes', () => {
      const rootNode = createRunNode();
      const fanOutChild = createRunNode({
        id: 11,
        nodeRole: 'standard',
        spawnerNodeId: 1,
        joinNodeId: 2,
        lineageDepth: 1,
        sequencePath: '1.1',
      });

      expect(hasRunNodeShape(rootNode)).toBe(true);
      expect(hasRunNodeShape(fanOutChild)).toBe(true);
    });

    it('rejects inconsistent spawner/join linkage', () => {
      const invalid = createRunNode({
        spawnerNodeId: 1,
        joinNodeId: null,
      });

      expect(hasRunNodeShape(invalid)).toBe(false);
    });

    it('rejects non-standard nodes with non-zero lineage depth', () => {
      const invalidSpawner = createRunNode({
        nodeRole: 'spawner',
        lineageDepth: 1,
      });

      expect(hasRunNodeShape(invalidSpawner)).toBe(false);
    });

    it('rejects linked standard nodes without sequencePath', () => {
      const invalidChild = createRunNode({
        spawnerNodeId: 1,
        joinNodeId: 2,
        lineageDepth: 1,
        sequencePath: null,
      });

      expect(hasRunNodeShape(invalidChild)).toBe(false);
    });
  });

  describe('hasFanOutGroupShape', () => {
    it('accepts valid fan-out group snapshots', () => {
      expect(hasFanOutGroupShape(createFanOutGroup())).toBe(true);
    });

    it('rejects duplicate child node ids', () => {
      const invalid = createFanOutGroup({
        childNodeIds: [11, 11],
      });

      expect(hasFanOutGroupShape(invalid)).toBe(false);
    });

    it('rejects counters that violate terminal-child invariants', () => {
      const invalid = createFanOutGroup({
        expectedChildren: 1,
        terminalChildren: 1,
        completedChildren: 1,
        failedChildren: 1,
        childNodeIds: [11, 12],
      });

      expect(hasFanOutGroupShape(invalid)).toBe(false);
    });
  });
});
