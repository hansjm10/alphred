import { describe, it, expect } from 'vitest';
import type { WorktreeInfo } from './worktree.js';

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
});
