// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPersistedRunWorktreeExplorer } from './load-persisted-worktree-explorer';

const execFileAsync = promisify(execFile);

async function runGit(worktreePath: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe('loadPersistedRunWorktreeExplorer', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    while (tempDirectories.length > 0) {
      const directory = tempDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads tracked paths from large git outputs without failing on maxBuffer', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-buffer-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    const longSegmentA = `segment-${'a'.repeat(172)}`;
    const longSegmentB = `segment-${'b'.repeat(172)}`;
    const nestedDirectory = join(worktreePath, longSegmentA, longSegmentB);
    await mkdir(nestedDirectory, { recursive: true });

    const fileCount = 2_400;
    const trackedPaths: string[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      const fileName = `tracked-${String(index).padStart(4, '0')}-${'c'.repeat(90)}.txt`;
      const relativePath = `${longSegmentA}/${longSegmentB}/${fileName}`;
      trackedPaths.push(relativePath);
      await writeFile(join(worktreePath, relativePath), `${index}\n`);
    }

    const nullSeparatedByteCount = trackedPaths.reduce((total, path) => total + path.length + 1, 0);
    expect(nullSeparatedByteCount).toBeGreaterThan(1_048_576);

    await runGit(worktreePath, ['add', '.']);

    const explorer = await loadPersistedRunWorktreeExplorer(worktreePath, trackedPaths[0]);

    expect(explorer.files).toHaveLength(fileCount);
    expect(explorer.changedFileCount).toBe(fileCount);
    expect(explorer.selectedPath).toBe(trackedPaths[0]);
    expect(explorer.previewError).toBeNull();
  });

  it('rejects preview content when a tracked path resolves outside the worktree root', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-symlink-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    const outsidePath = join(tempRoot, 'outside-secret.txt');
    const symlinkPath = join(worktreePath, 'leak.txt');
    await writeFile(outsidePath, 'outside-secret');
    await symlink(outsidePath, symlinkPath);
    await runGit(worktreePath, ['add', 'leak.txt']);
    await runGit(worktreePath, ['commit', '-m', 'track symlink']);

    const explorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'leak.txt');

    expect(explorer.selectedPath).toBe('leak.txt');
    expect(explorer.previewError).toBeNull();
    expect(explorer.preview?.content).toBeNull();
    expect(explorer.preview?.contentMessage).toBe(
      'File content is unavailable because this path resolves outside the worktree root.',
    );
  });
});
