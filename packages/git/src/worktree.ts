import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  path: string;
  branch: string;
  commit: string;
};

export async function createWorktree(
  repoDir: string,
  worktreeBase: string,
  branch: string,
): Promise<WorktreeInfo> {
  const worktreePath = join(worktreeBase, branch.replace(/\//g, '-'));

  await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath], {
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
