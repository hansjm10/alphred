import { describe, expect, it } from 'vitest';
import * as git from './index.js';

describe('git index exports', () => {
  it('re-exports worktree helpers and scm provider utilities', () => {
    expect(typeof git.createWorktree).toBe('function');
    expect(typeof git.removeWorktree).toBe('function');
    expect(typeof git.listWorktrees).toBe('function');
    expect(typeof git.WorktreeManager).toBe('function');
    expect(typeof git.generateBranchName).toBe('function');
    expect(typeof git.generateConfiguredBranchName).toBe('function');
    expect(typeof git.resolveBranchTemplate).toBe('function');
    expect(typeof git.getGitHubIssue).toBe('function');
    expect(typeof git.createGitHubPR).toBe('function');
    expect(typeof git.cloneGitHubRepo).toBe('function');
    expect(typeof git.getAzureWorkItem).toBe('function');
    expect(typeof git.createAzurePR).toBe('function');
    expect(typeof git.cloneAzureRepo).toBe('function');
    expect(typeof git.createScmProvider).toBe('function');
    expect(typeof git.GitHubScmProvider).toBe('function');
    expect(typeof git.AzureDevOpsScmProvider).toBe('function');
    expect(typeof git.ensureRepositoryClone).toBe('function');
    expect(typeof git.fetchRepository).toBe('function');
    expect(Array.isArray(git.repositorySyncModes)).toBe(true);
    expect(Array.isArray(git.repositorySyncStrategies)).toBe(true);
    expect(Array.isArray(git.repositorySyncStatuses)).toBe(true);
    expect(typeof git.resolveSandboxDir).toBe('function');
    expect(typeof git.deriveSandboxRepoPath).toBe('function');
  });
});
