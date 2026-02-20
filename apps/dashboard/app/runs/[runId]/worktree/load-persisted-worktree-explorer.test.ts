// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

    const explorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'leak.txt', 'content');

    expect(explorer.selectedPath).toBe('leak.txt');
    expect(explorer.previewError).toBeNull();
    expect(explorer.preview?.content).toBeNull();
    expect(explorer.preview?.contentMessage).toBe(
      'File content is unavailable because this path resolves outside the worktree root.',
    );
  });

  it('tracks renamed destination paths as changed entries', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-rename-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    await writeFile(join(worktreePath, 'old.txt'), 'old-content\n');
    await runGit(worktreePath, ['add', 'old.txt']);
    await runGit(worktreePath, ['commit', '-m', 'add old']);

    await rename(join(worktreePath, 'old.txt'), join(worktreePath, 'new.txt'));
    await runGit(worktreePath, ['add', '-A']);

    const explorer = await loadPersistedRunWorktreeExplorer(worktreePath, undefined);

    expect(explorer.changedFileCount).toBe(1);
    expect(explorer.selectedPath).toBe('new.txt');
    expect(explorer.files.some((file) => file.path === 'new.txt' && file.changed)).toBe(true);
    expect(explorer.files.some((file) => file.path === 'old.txt')).toBe(false);
    expect(explorer.preview?.path).toBe('new.txt');
  });

  it('loads only diff data in diff mode and only content data in content mode', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-preview-mode-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    await writeFile(join(worktreePath, 'target.ts'), 'export const value = 1;\n');
    await runGit(worktreePath, ['add', 'target.ts']);
    await runGit(worktreePath, ['commit', '-m', 'add target']);
    await writeFile(join(worktreePath, 'target.ts'), 'export const value = 2;\n');

    const diffModeExplorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'target.ts', 'diff');
    expect(diffModeExplorer.previewError).toBeNull();
    expect(diffModeExplorer.preview?.diff).toContain('export const value = 2;');
    expect(diffModeExplorer.preview?.content).toBeNull();
    expect(diffModeExplorer.preview?.contentMessage).toBe('Content preview is available in content view.');

    const contentModeExplorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'target.ts', 'content');
    expect(contentModeExplorer.previewError).toBeNull();
    expect(contentModeExplorer.preview?.content).toContain('export const value = 2;');
    expect(contentModeExplorer.preview?.diff).toBeNull();
    expect(contentModeExplorer.preview?.diffMessage).toBe('Diff summary is available in diff view.');
  });

  it('returns deleted-file diff output and content unavailability messaging', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-deleted-file-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    await writeFile(join(worktreePath, 'delete-me.txt'), 'before-delete\n');
    await runGit(worktreePath, ['add', 'delete-me.txt']);
    await runGit(worktreePath, ['commit', '-m', 'add deletable file']);

    await rm(join(worktreePath, 'delete-me.txt'));
    await runGit(worktreePath, ['add', '-A']);

    const diffModeExplorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'delete-me.txt', 'diff');
    expect(diffModeExplorer.previewError).toBeNull();
    expect(diffModeExplorer.selectedPath).toBe('delete-me.txt');
    expect(diffModeExplorer.preview?.changed).toBe(true);
    expect(diffModeExplorer.preview?.diff).toContain('delete-me.txt');
    expect(diffModeExplorer.preview?.diff).toContain('before-delete');
    expect(diffModeExplorer.preview?.content).toBeNull();
    expect(diffModeExplorer.preview?.contentMessage).toBe('Content preview is available in content view.');

    const contentModeExplorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'delete-me.txt', 'content');
    expect(contentModeExplorer.previewError).toBeNull();
    expect(contentModeExplorer.preview?.diff).toBeNull();
    expect(contentModeExplorer.preview?.diffMessage).toBe('Diff summary is available in diff view.');
    expect(contentModeExplorer.preview?.content).toBeNull();
    expect(contentModeExplorer.preview?.contentMessage).toBe(
      'File content is unavailable because this path no longer resolves in the worktree.',
    );
    expect(contentModeExplorer.preview?.binary).toBe(false);
  });

  it('truncates large content preview payloads', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'alphred-worktree-loader-content-truncation-'));
    tempDirectories.push(tempRoot);
    const worktreePath = join(tempRoot, 'repo');

    await mkdir(worktreePath);
    await runGit(worktreePath, ['init']);
    await runGit(worktreePath, ['config', 'user.name', 'Test Runner']);
    await runGit(worktreePath, ['config', 'user.email', 'test@example.com']);

    const largeContent = `${'abcdefghijklmnopqrstuvwxyz'.repeat(4_000)}\n`;
    await writeFile(join(worktreePath, 'large.txt'), largeContent);
    await runGit(worktreePath, ['add', 'large.txt']);
    await runGit(worktreePath, ['commit', '-m', 'add large file']);

    const explorer = await loadPersistedRunWorktreeExplorer(worktreePath, 'large.txt', 'content');

    expect(explorer.previewError).toBeNull();
    expect(explorer.preview?.binary).toBe(false);
    expect(explorer.preview?.contentMessage).toBe('Content preview is truncated for performance.');
    expect(explorer.preview?.content?.length ?? 0).toBeLessThanOrEqual(14_002);
  });
});
