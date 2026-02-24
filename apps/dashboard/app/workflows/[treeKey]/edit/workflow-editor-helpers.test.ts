import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { DashboardWorkflowDraftNode } from '../../../../src/server/dashboard-contracts';
import { createDraftNode, mapNodeFromReactFlow } from './workflow-editor-helpers';

function createDraftNodeData(overrides: Partial<DashboardWorkflowDraftNode> = {}): DashboardWorkflowDraftNode {
  return {
    nodeKey: 'design',
    displayName: 'Design',
    nodeType: 'agent',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    executionPermissions: null,
    maxRetries: 0,
    sequenceIndex: 10,
    position: { x: 0, y: 0 },
    promptTemplate: { content: 'Draft prompt', contentType: 'markdown' },
    ...overrides,
  };
}

describe('workflow-editor-helpers', () => {
  it('omits null execution permissions when mapping nodes from React Flow', () => {
    const mapped = mapNodeFromReactFlow({
      id: 'design',
      position: { x: 12.6, y: 9.1 },
      data: {
        ...createDraftNodeData(),
        label: 'Design',
      },
    } as unknown as Node);

    expect(mapped.position).toEqual({ x: 13, y: 9 });
    expect(mapped).not.toHaveProperty('executionPermissions');
  });

  it('preserves execution permissions when they are set on mapped nodes', () => {
    const mapped = mapNodeFromReactFlow({
      id: 'design',
      position: { x: 18.4, y: 20.6 },
      data: {
        ...createDraftNodeData({
          executionPermissions: {
            sandboxMode: 'workspace-write',
            additionalDirectories: ['/tmp/cache'],
          },
        }),
        label: 'Design',
      },
    } as unknown as Node);

    expect(mapped.executionPermissions).toEqual({
      sandboxMode: 'workspace-write',
      additionalDirectories: ['/tmp/cache'],
    });
  });

  it('initializes new agent draft nodes with null execution permissions and unique keys', () => {
    const created = createDraftNode({
      nodeType: 'agent',
      existingNodeKeys: new Set(['agent', 'agent-2']),
      nextSequenceIndex: 40,
      position: { x: 99.9, y: 50.2 },
    });

    expect(created.nodeKey).toBe('agent-3');
    expect(created.executionPermissions).toBeNull();
    expect(created.sequenceIndex).toBe(40);
    expect(created.position).toEqual({ x: 100, y: 50 });
  });
});
