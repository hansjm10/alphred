import { describe, it, expect } from 'vitest';
import type { CreateWorktreeParams, WorktreeInfo } from './worktree.js';

describe('worktree types', () => {
  it('should type-check WorktreeInfo', () => {
    const info: WorktreeInfo = {
      path: '/tmp/worktree',
      branch: 'feature-branch',
      commit: 'abc123',
    };
    expect(info.path).toBe('/tmp/worktree');
    expect(info.branch).toBe('feature-branch');
  });

  it('should type-check createWorktree params for generated branch names', () => {
    const params: CreateWorktreeParams = {
      branchTemplate: 'alphred/{tree-key}/{run-id}',
      branchContext: {
        treeKey: 'design_tree',
        runId: 42,
      },
      baseRef: 'main',
    };

    expect(params.branchContext?.runId).toBe(42);
    expect(params.baseRef).toBe('main');
  });
});
