import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateWorktreeParams, WorktreeInfo } from './worktree.js';

const { execFileAsyncMock, execFileMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

import { createWorktree, deleteBranch, listWorktrees, removeWorktree } from './worktree.js';

describe('worktree types', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileAsyncMock.mockReset();
  });

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

  it('creates a worktree, trimming branch and baseRef before invoking git', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });

    const result = await createWorktree('/tmp/repo', '/tmp/worktrees', {
      branch: '  feature/cool-fix  ',
      baseRef: '  main  ',
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['worktree', 'add', '-b', 'feature/cool-fix', '/tmp/worktrees/feature-cool-fix', 'main'],
      { cwd: '/tmp/repo' },
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: '/tmp/worktrees/feature-cool-fix' },
    );
    expect(result).toEqual({
      path: '/tmp/worktrees/feature-cool-fix',
      branch: 'feature/cool-fix',
      commit: 'abc123',
    });
  });

  it('supports generated branch names without requiring baseRef', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def456\n', stderr: '' });

    const result = await createWorktree('/tmp/repo', '/tmp/worktrees', {
      branchTemplate: 'alphred/{tree-key}/{run-id}-{node-key}',
      branchContext: {
        treeKey: 'design_tree',
        runId: 42,
        nodeKey: 'implement',
      },
      baseRef: '   ',
    });

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['worktree', 'add', '-b', 'alphred/design-tree/42-implement', '/tmp/worktrees/alphred-design-tree-42-implement'],
      { cwd: '/tmp/repo' },
    );
    expect(result.branch).toBe('alphred/design-tree/42-implement');
  });

  it('throws when neither branch nor branchContext is provided', async () => {
    await expect(
      createWorktree('/tmp/repo', '/tmp/worktrees', {
        branchTemplate: 'alphred/{tree-key}/{run-id}',
      }),
    ).rejects.toThrow('createWorktree requires either a branch name or branchContext.');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('removes worktrees using git worktree remove --force', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await removeWorktree('/tmp/repo', '/tmp/worktrees/feature-cool-fix');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/tmp/worktrees/feature-cool-fix'],
      { cwd: '/tmp/repo' },
    );
  });

  it('deletes branches using git branch --delete --force', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await deleteBranch('/tmp/repo', '  feature/cool-fix  ');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'git',
      ['branch', '--delete', '--force', 'feature/cool-fix'],
      { cwd: '/tmp/repo' },
    );
  });

  it('parses git worktree list output, including detached entries', async () => {
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: `worktree /tmp/repo
HEAD 111aaa
branch refs/heads/main

worktree /tmp/worktrees/feature-cool-fix
HEAD 222bbb
branch refs/heads/feature/cool-fix

worktree /tmp/worktrees/detached
HEAD 333ccc

`,
      stderr: '',
    });

    await expect(listWorktrees('/tmp/repo')).resolves.toEqual([
      {
        path: '/tmp/repo',
        branch: 'main',
        commit: '111aaa',
      },
      {
        path: '/tmp/worktrees/feature-cool-fix',
        branch: 'feature/cool-fix',
        commit: '222bbb',
      },
      {
        path: '/tmp/worktrees/detached',
        branch: 'detached',
        commit: '333ccc',
      },
    ]);
  });
});
