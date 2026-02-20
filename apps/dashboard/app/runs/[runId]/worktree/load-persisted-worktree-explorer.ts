import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 14_000;
const MAX_CONTENT_BYTES = 96_000;
const MAX_CONTENT_CHARS = 14_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type PersistedRunWorktreeExplorerFile = Readonly<{
  path: string;
  changed: boolean;
}>;

export type PersistedRunWorktreePreview = Readonly<{
  path: string;
  changed: boolean;
  diff: string | null;
  diffMessage: string | null;
  content: string | null;
  contentMessage: string | null;
  binary: boolean;
}>;

export type PersistedRunWorktreeExplorer = Readonly<{
  files: readonly PersistedRunWorktreeExplorerFile[];
  changedFileCount: number;
  selectedPath: string | null;
  preview: PersistedRunWorktreePreview | null;
  previewError: string | null;
}>;

function parseNullSeparatedList(output: string): string[] {
  return output
    .split('\u0000')
    .filter((entry) => entry.length > 0);
}

function parseStatusPaths(statusOutput: string): Set<string> {
  const entries = statusOutput.split('\u0000');
  const paths = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    let path = entry.slice(3);

    const renamedOrCopied = status.includes('R') || status.includes('C');
    if (renamedOrCopied) {
      const nextEntry = entries[index + 1];
      if (nextEntry && nextEntry.length > 0) {
        path = nextEntry;
        index += 1;
      }
    }

    if (path.length > 0) {
      paths.add(path);
    }
  }

  return paths;
}

function toComparablePaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function resolveSelectedPath(
  files: readonly PersistedRunWorktreeExplorerFile[],
  requestedPath: string | string[] | undefined,
): string | null {
  const firstRequestedPath = Array.isArray(requestedPath) ? requestedPath[0] : requestedPath;
  if (firstRequestedPath && files.some((file) => file.path === firstRequestedPath)) {
    return firstRequestedPath;
  }

  return files.find((file) => file.changed)?.path ?? files[0]?.path ?? null;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n…`;
}

function resolveWorktreeFilePath(worktreePath: string, relativePath: string): string {
  const resolvedWorktreeRoot = resolve(worktreePath);
  const absolutePath = resolve(resolvedWorktreeRoot, relativePath);

  if (!pathWithinRoot(resolvedWorktreeRoot, absolutePath)) {
    throw new Error(`Rejected worktree file path outside worktree root: ${relativePath}`);
  }

  return absolutePath;
}

function pathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath === rootPath || candidatePath.startsWith(normalizedRoot);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function runGit(worktreePath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });

  return stdout;
}

async function runGitBestEffort(worktreePath: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(worktreePath, args);
  } catch {
    return null;
  }
}

async function readDiffPreview(
  worktreePath: string,
  path: string,
  changed: boolean,
  tracked: boolean,
): Promise<{ diff: string | null; message: string | null }> {
  if (!changed) {
    return {
      diff: null,
      message: 'No diff available because this file is unchanged in this worktree snapshot.',
    };
  }

  const diffAgainstHead = await runGitBestEffort(worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    'HEAD',
    '--',
    path,
  ]);

  if (diffAgainstHead && diffAgainstHead.trim().length > 0) {
    return {
      diff: truncate(diffAgainstHead.trim(), MAX_DIFF_CHARS),
      message: null,
    };
  }

  const diffAgainstIndex = await runGitBestEffort(worktreePath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--',
    path,
  ]);

  if (diffAgainstIndex && diffAgainstIndex.trim().length > 0) {
    return {
      diff: truncate(diffAgainstIndex.trim(), MAX_DIFF_CHARS),
      message: null,
    };
  }

  if (!tracked) {
    return {
      diff: null,
      message: 'Diff summary is unavailable for untracked files. Open raw content for details.',
    };
  }

  return {
    diff: null,
    message: 'Diff summary is unavailable for this changed file.',
  };
}

async function readContentPreview(
  worktreePath: string,
  path: string,
): Promise<{ content: string | null; message: string | null; binary: boolean }> {
  const absolutePath = resolveWorktreeFilePath(worktreePath, path);

  try {
    const resolvedWorktreeRoot = await realpath(resolve(worktreePath));
    const resolvedAbsolutePath = await realpath(absolutePath);
    if (!pathWithinRoot(resolvedWorktreeRoot, resolvedAbsolutePath)) {
      return {
        content: null,
        message: 'File content is unavailable because this path resolves outside the worktree root.',
        binary: false,
      };
    }

    const buffer = await readFile(absolutePath);
    const truncated = buffer.length > MAX_CONTENT_BYTES ? buffer.subarray(0, MAX_CONTENT_BYTES) : buffer;

    if (truncated.includes(0)) {
      return {
        content: null,
        message: 'Binary file preview is unavailable. Use local tools to inspect this file.',
        binary: true,
      };
    }

    const text = truncated.toString('utf8');
    if (buffer.length > MAX_CONTENT_BYTES || text.length > MAX_CONTENT_CHARS) {
      return {
        content: truncate(text, MAX_CONTENT_CHARS),
        message: 'Content preview is truncated for performance.',
        binary: false,
      };
    }

    return {
      content: text,
      message: null,
      binary: false,
    };
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
      return {
        content: null,
        message: 'File content is unavailable because this path no longer resolves in the worktree.',
        binary: false,
      };
    }

    throw error;
  }
}

export async function loadPersistedRunWorktreeExplorer(
  worktreePath: string,
  requestedPath: string | string[] | undefined,
): Promise<PersistedRunWorktreeExplorer> {
  const trackedPaths = parseNullSeparatedList(await runGit(worktreePath, ['ls-files', '-z']));
  const trackedPathSet = new Set(trackedPaths);
  const changedPaths = parseStatusPaths(
    await runGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
  );

  const files = toComparablePaths([...trackedPaths, ...changedPaths]).map((path) => ({
    path,
    changed: changedPaths.has(path),
  }));
  const changedFileCount = files.filter((file) => file.changed).length;

  const selectedPath = resolveSelectedPath(files, requestedPath);
  if (!selectedPath) {
    return {
      files,
      changedFileCount,
      selectedPath: null,
      preview: null,
      previewError: null,
    };
  }

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  if (!selectedFile) {
    return {
      files,
      changedFileCount,
      selectedPath: null,
      preview: null,
      previewError: null,
    };
  }

  try {
    const [diffPreview, contentPreview] = await Promise.all([
      readDiffPreview(worktreePath, selectedFile.path, selectedFile.changed, trackedPathSet.has(selectedFile.path)),
      readContentPreview(worktreePath, selectedFile.path),
    ]);

    return {
      files,
      changedFileCount,
      selectedPath,
      preview: {
        path: selectedFile.path,
        changed: selectedFile.changed,
        diff: diffPreview.diff,
        diffMessage: diffPreview.message,
        content: contentPreview.content,
        contentMessage: contentPreview.message,
        binary: contentPreview.binary,
      },
      previewError: null,
    };
  } catch {
    return {
      files,
      changedFileCount,
      selectedPath,
      preview: null,
      previewError: 'Unable to load preview data for the selected path. Retry this path or choose another file.',
    };
  }
}
