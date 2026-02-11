import { describe, expect, it } from 'vitest';
import * as git from './index.js';

describe('git index exports', () => {
  it('re-exports worktree and provider-specific git helpers', () => {
    expect(typeof git.createWorktree).toBe('function');
    expect(typeof git.removeWorktree).toBe('function');
    expect(typeof git.listWorktrees).toBe('function');
    expect(typeof git.getGitHubIssue).toBe('function');
    expect(typeof git.createGitHubPR).toBe('function');
    expect(typeof git.getAzureWorkItem).toBe('function');
    expect(typeof git.createAzurePR).toBe('function');
  });
});
