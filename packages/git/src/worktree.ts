import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { generateConfiguredBranchName, type BranchNameContext } from './branchName.js';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  path: string;
  branch: string;
  commit: string;
};

export type CreateWorktreeParams = {
  branch?: string;
  branchTemplate?: string | null;
  branchContext?: BranchNameContext;
  baseRef?: string;
};

type ResolvedCreateWorktreeParams = {
  branch: string;
  baseRef?: string;
};

function resolveWorktreeParams(branchOrParams: string | CreateWorktreeParams): ResolvedCreateWorktreeParams {
  if (typeof branchOrParams === 'string') {
    return {
      branch: branchOrParams,
    };
  }

  if (branchOrParams.branch?.trim()) {
    return {
      branch: branchOrParams.branch.trim(),
      baseRef: branchOrParams.baseRef,
    };
  }

  if (branchOrParams.branchContext) {
    return {
      branch: generateConfiguredBranchName(branchOrParams.branchContext, branchOrParams.branchTemplate),
      baseRef: branchOrParams.baseRef,
    };
  }

  throw new Error('createWorktree requires either a branch name or branchContext.');
}

export async function createWorktree(
  repoDir: string,
  worktreeBase: string,
  branchOrParams: string | CreateWorktreeParams,
): Promise<WorktreeInfo> {
  const { branch, baseRef } = resolveWorktreeParams(branchOrParams);
  const worktreePath = join(worktreeBase, branch.replaceAll('/', '-'));
  const worktreeAddArgs = ['worktree', 'add', '-b', branch, worktreePath];
  if (baseRef !== undefined && baseRef.trim().length > 0) {
    worktreeAddArgs.push(baseRef.trim());
  }

  await execFileAsync('git', worktreeAddArgs, {
    cwd: repoDir,
  });

  const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
  });

  return {
    path: worktreePath,
    branch,
    commit: commit.trim(),
  };
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoDir,
  });
}

export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  const trimmedBranch = branch.trim();
  if (trimmedBranch.length === 0) {
    return;
  }

  await execFileAsync('git', ['branch', '--delete', '--force', trimmedBranch], {
    cwd: repoDir,
  });
}

export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
  });

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === '') {
      if (current.path && current.commit) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? 'detached',
          commit: current.commit,
        });
      }
      current = {};
    }
  }

  return worktrees;
}
