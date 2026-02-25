import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createDatabase, getRepositoryByName, insertRepository, migrateDatabase } from '@alphred/db';
import type { ScmProviderKind } from '@alphred/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRepositoryClone } from './repositoryClone.js';
import type { ScmProvider } from './scmProvider.js';

const execFileAsync = promisify(execFile);

function createMigratedDb() {
  const db = createDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

async function createSandboxDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alphred-git-clone-test-'));
}

async function initializeGitRepository(path: string, originUrl?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: path });
  if (originUrl !== undefined) {
    await execFileAsync('git', ['remote', 'add', 'origin', originUrl], { cwd: path });
  }
}

type SyncFixture = {
  sandboxDir: string;
  sourcePath: string;
  remotePath: string;
  localPath: string;
  expectedRemoteUrl: string;
};

async function createSyncFixture(): Promise<SyncFixture> {
  const sandboxDir = await createSandboxDir();
  const fixtureDir = await createSandboxDir();
  cleanupPaths.add(sandboxDir);
  cleanupPaths.add(fixtureDir);

  const sourcePath = join(fixtureDir, 'source');
  const remotePath = join(fixtureDir, 'remote.git');
  const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
  const expectedRemoteUrl = 'https://github.com/acme/frontend.git';

  await mkdir(sourcePath, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: sourcePath });
  await execFileAsync('git', ['config', 'user.email', 'alphred-tests@example.com'], { cwd: sourcePath });
  await execFileAsync('git', ['config', 'user.name', 'Alphred Tests'], { cwd: sourcePath });
  await execFileAsync('git', ['checkout', '-b', 'main'], { cwd: sourcePath });
  await writeFile(join(sourcePath, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: sourcePath });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: sourcePath });
  await execFileAsync('git', ['init', '--bare', remotePath]);
  await execFileAsync('git', ['remote', 'add', 'origin', remotePath], { cwd: sourcePath });
  await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: sourcePath });
  await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remotePath });

  await mkdir(dirname(localPath), { recursive: true });
  await execFileAsync('git', ['clone', remotePath, localPath]);
  await execFileAsync('git', ['remote', 'set-url', 'origin', expectedRemoteUrl], { cwd: localPath });
  await execFileAsync('git', ['config', 'user.email', 'alphred-tests@example.com'], { cwd: localPath });
  await execFileAsync('git', ['config', 'user.name', 'Alphred Tests'], { cwd: localPath });

  return {
    sandboxDir,
    sourcePath,
    remotePath,
    localPath,
    expectedRemoteUrl,
  };
}

function createFixtureFetchAll(remotePath: string) {
  return async (localPath: string): Promise<void> => {
    await execFileAsync(
      'git',
      ['fetch', '--prune', '--tags', remotePath, '+refs/heads/*:refs/remotes/origin/*'],
      { cwd: localPath },
    );
  };
}

async function createSyncEnvironmentWithoutGitIdentity(sandboxDir: string): Promise<NodeJS.ProcessEnv> {
  const emptyGlobalConfigPath = join(sandboxDir, 'empty.gitconfig');
  await writeFile(emptyGlobalConfigPath, '');
  return {
    ALPHRED_SANDBOX_DIR: sandboxDir,
    HOME: sandboxDir,
    XDG_CONFIG_HOME: sandboxDir,
    GIT_CONFIG_GLOBAL: emptyGlobalConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

async function clearLocalGitIdentity(path: string): Promise<void> {
  await execFileAsync('git', ['config', '--local', '--unset-all', 'user.email'], { cwd: path }).catch(() => undefined);
  await execFileAsync('git', ['config', '--local', '--unset-all', 'user.name'], { cwd: path }).catch(() => undefined);
}

async function commitFile(path: string, relativePath: string, content: string, message: string): Promise<string> {
  await writeFile(join(path, relativePath), content);
  await execFileAsync('git', ['add', relativePath], { cwd: path });
  await execFileAsync('git', ['commit', '-m', message], { cwd: path });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path });
  return stdout.trim();
}

function createMockProvider(
  kind: ScmProviderKind,
  cloneImpl?: (remote: string, localPath: string, environment?: NodeJS.ProcessEnv) => Promise<void>,
) {
  const cloneRepo = vi.fn(cloneImpl ?? (async () => undefined));

  const provider: ScmProvider = {
    kind,
    checkAuth: async () => ({ authenticated: true }),
    cloneRepo,
    getWorkItem: async () => {
      throw new Error('not implemented');
    },
    createPullRequest: async () => {
      throw new Error('not implemented');
    },
  };

  return {
    provider,
    cloneRepo,
  };
}

const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const path of cleanupPaths) {
    await rm(path, { recursive: true, force: true });
    cleanupPaths.delete(path);
  }
});

describe('ensureRepositoryClone', () => {
  it('inserts new repositories, clones to sandbox, and marks status as cloned', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const expectedPath = join(sandboxDir, 'github', 'acme', 'frontend');
    const { provider, cloneRepo } = createMockProvider('github', async (_remote, localPath) => {
      await mkdir(localPath, { recursive: true });
      await writeFile(join(localPath, '.git'), '');
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(cloneRepo).toHaveBeenCalledWith('https://github.com/acme/frontend.git', expectedPath, {
      ALPHRED_SANDBOX_DIR: sandboxDir,
    });
    expect(result.repository.cloneStatus).toBe('cloned');
    expect(result.repository.localPath).toBe(expectedPath);
  });

  it('persists the remote default branch discovered from origin/HEAD after clone', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    const remoteFixtureDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    cleanupPaths.add(remoteFixtureDir);

    const sourcePath = join(remoteFixtureDir, 'source');
    const remotePath = join(remoteFixtureDir, 'remote.git');
    await mkdir(sourcePath, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: sourcePath });
    await execFileAsync('git', ['config', 'user.email', 'alphred-tests@example.com'], { cwd: sourcePath });
    await execFileAsync('git', ['config', 'user.name', 'Alphred Tests'], { cwd: sourcePath });
    await execFileAsync('git', ['checkout', '-b', 'master'], { cwd: sourcePath });
    await writeFile(join(sourcePath, 'README.md'), '# fixture\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: sourcePath });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: sourcePath });
    await execFileAsync('git', ['init', '--bare', remotePath]);
    await execFileAsync('git', ['remote', 'add', 'origin', remotePath], { cwd: sourcePath });
    await execFileAsync('git', ['push', '--set-upstream', 'origin', 'master'], { cwd: sourcePath });
    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: remotePath });

    const expectedRemoteUrl = 'https://github.com/acme/default-branch-fixture.git';
    const { provider } = createMockProvider('github', async (_remote, localPath) => {
      await execFileAsync('git', ['clone', remotePath, localPath]);
      await execFileAsync('git', ['remote', 'set-url', 'origin', expectedRemoteUrl], { cwd: localPath });
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'default-branch-fixture',
        provider: 'github',
        remoteUrl: expectedRemoteUrl,
        remoteRef: 'acme/default-branch-fixture',
      },
      provider,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(result.repository.defaultBranch).toBe('master');
    expect(getRepositoryByName(db, 'default-branch-fixture')?.defaultBranch).toBe('master');
  });

  it('fetches existing cloned repositories instead of recloning', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend.git');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github');

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('fetched');
    expect(fetchAll).toHaveBeenCalledWith(
      localPath,
      { ALPHRED_SANDBOX_DIR: sandboxDir },
      {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
      },
    );
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('returns fetched sync status by default for existing repositories', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend.git');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('fetched');
    expect(result.sync).toMatchObject({
      mode: 'fetch',
      strategy: null,
      status: 'fetched',
      conflictMessage: null,
    });
  });

  it('pulls fetched updates with ff-only strategy when sync mode is pull', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const remoteHead = await commitFile(
      fixture.sourcePath,
      'remote.txt',
      'remote update\n',
      'remote: update main',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    const { stdout: localHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    expect(localHeadStdout.trim()).toBe(remoteHead);
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'ff-only',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('fast-forwards with merge strategy when local branch is only behind origin', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const remoteHead = await commitFile(
      fixture.sourcePath,
      'remote.txt',
      'remote update\n',
      'remote: update main',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'merge',
      },
    });

    const { stdout: localHeadStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    expect(localHeadStdout.trim()).toBe(remoteHead);
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'merge',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('restores detached HEAD after syncing updates on the target branch', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const remoteHead = await commitFile(
      fixture.sourcePath,
      'remote.txt',
      'remote update\n',
      'remote: update main',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });

    const { stdout: detachedHeadBeforeStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    const detachedHeadBefore = detachedHeadBeforeStdout.trim();
    await execFileAsync('git', ['checkout', '--detach', detachedHeadBefore], {
      cwd: fixture.localPath,
    });

    const { stdout: detachedStateBeforeStdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fixture.localPath,
    });
    expect(detachedStateBeforeStdout.trim()).toBe('HEAD');

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    const { stdout: headAfterStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    const { stdout: detachedStateAfterStdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fixture.localPath,
    });
    const { stdout: mainBranchAfterStdout } = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], {
      cwd: fixture.localPath,
    });

    expect(headAfterStdout.trim()).toBe(detachedHeadBefore);
    expect(detachedStateAfterStdout.trim()).toBe('HEAD');
    expect(mainBranchAfterStdout.trim()).toBe(remoteHead);
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'ff-only',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('returns conflicted sync status when ff-only cannot fast-forward', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    await commitFile(
      fixture.localPath,
      'local.txt',
      'local change\n',
      'local: diverging change',
    );
    await commitFile(
      fixture.sourcePath,
      'remote.txt',
      'remote change\n',
      'remote: diverging change',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    expect(result.sync?.status).toBe('conflicted');
    expect(result.sync?.conflictMessage).toContain('Sync conflict on branch "main"');
    expect(getRepositoryByName(db, 'frontend')?.cloneStatus).toBe('cloned');
  });

  it('treats missing remote sync branches as up_to_date instead of throwing', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const { stdout: localHeadBeforeStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });

    await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/branchless'], {
      cwd: fixture.remotePath,
    });
    await execFileAsync('git', ['push', 'origin', '--delete', 'main'], { cwd: fixture.sourcePath });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    const { stdout: localHeadAfterStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    expect(localHeadAfterStdout.trim()).toBe(localHeadBeforeStdout.trim());
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'ff-only',
      branch: 'main',
      status: 'up_to_date',
      conflictMessage: null,
    });
  });

  it('reports up_to_date when pull sync finds no remote divergence', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'ff-only',
      branch: 'main',
      status: 'up_to_date',
      conflictMessage: null,
    });
  });

  it('creates a missing local branch during pull sync and marks the result as updated', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    const { stdout: detachedRevisionStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: fixture.localPath,
    });
    await execFileAsync('git', ['checkout', '--detach', detachedRevisionStdout.trim()], {
      cwd: fixture.localPath,
    });
    await execFileAsync('git', ['branch', '-D', 'main'], {
      cwd: fixture.localPath,
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'ff-only',
      },
    });

    await expect(
      execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
        cwd: fixture.localPath,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringMatching(/[0-9a-f]{40}\n?$/i),
    });
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'ff-only',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('aborts merge sync conflicts and reports a conflicted status', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    await commitFile(
      fixture.localPath,
      'README.md',
      '# local change\n',
      'local: conflicting README change',
    );
    await commitFile(
      fixture.sourcePath,
      'README.md',
      '# remote change\n',
      'remote: conflicting README change',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
      },
      sync: {
        mode: 'pull',
        strategy: 'merge',
      },
    });

    const { stdout: statusStdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: fixture.localPath,
    });
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
        cwd: fixture.localPath,
      }),
    ).rejects.toThrow();
    expect(statusStdout.trim()).toBe('');
    expect(result.sync?.status).toBe('conflicted');
    expect(result.sync?.conflictMessage).toContain('strategy "merge"');
  });

  it('returns conflicted status when rebase sync is blocked by local working tree changes', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    await commitFile(
      fixture.sourcePath,
      'remote.txt',
      'remote update\n',
      'remote: update main',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });
    await writeFile(join(fixture.localPath, 'README.md'), '# dirty working tree\n');

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment: {
        ALPHRED_SANDBOX_DIR: fixture.sandboxDir,
        GIT_AUTHOR_NAME: '  Alphred Author  ',
        GIT_AUTHOR_EMAIL: '  author@example.com  ',
      },
      sync: {
        mode: 'pull',
        strategy: 'rebase',
      },
    });

    expect(result.sync?.status).toBe('conflicted');
    expect(result.sync?.conflictMessage).toContain('strategy "rebase"');
    expect(result.sync?.conflictMessage).toContain('Please commit or stash them.');
  });

  it('applies merge strategy when branches diverge without conflicts', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    await commitFile(
      fixture.localPath,
      'local-only.txt',
      'local only\n',
      'local: add local-only file',
    );
    await commitFile(
      fixture.sourcePath,
      'remote-only.txt',
      'remote only\n',
      'remote: add remote-only file',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });
    await clearLocalGitIdentity(fixture.localPath);
    const environment = await createSyncEnvironmentWithoutGitIdentity(fixture.sandboxDir);

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment,
      sync: {
        mode: 'pull',
        strategy: 'merge',
      },
    });

    const { stdout: mergeParentsStdout } = await execFileAsync(
      'git',
      ['show', '--format=%P', '--no-patch', 'HEAD'],
      { cwd: fixture.localPath },
    );
    expect(mergeParentsStdout.trim().split(/\s+/)).toHaveLength(2);
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'merge',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('applies rebase strategy without configured git identity', async () => {
    const fixture = await createSyncFixture();
    const db = createMigratedDb();

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: fixture.expectedRemoteUrl,
      remoteRef: 'acme/frontend',
      localPath: fixture.localPath,
      cloneStatus: 'cloned',
      defaultBranch: 'main',
    });

    await commitFile(
      fixture.localPath,
      'local-only.txt',
      'local only\n',
      'local: add local-only file',
    );
    const remoteHead = await commitFile(
      fixture.sourcePath,
      'remote-only.txt',
      'remote only\n',
      'remote: add remote-only file',
    );
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.sourcePath });
    await clearLocalGitIdentity(fixture.localPath);
    const environment = await createSyncEnvironmentWithoutGitIdentity(fixture.sandboxDir);

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: fixture.expectedRemoteUrl,
        remoteRef: 'acme/frontend',
        defaultBranch: 'main',
      },
      fetchAll: createFixtureFetchAll(fixture.remotePath),
      environment,
      sync: {
        mode: 'pull',
        strategy: 'rebase',
      },
    });

    const { stdout: headParentStdout } = await execFileAsync('git', ['rev-parse', 'HEAD^'], {
      cwd: fixture.localPath,
    });
    expect(headParentStdout.trim()).toBe(remoteHead);
    expect(result.sync).toEqual({
      mode: 'pull',
      strategy: 'rebase',
      branch: 'main',
      status: 'updated',
      conflictMessage: null,
    });
  });

  it('fetches existing git repositories even when clone status is error', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend.git');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'error',
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github');

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('fetched');
    expect(result.repository.cloneStatus).toBe('cloned');
    expect(fetchAll).toHaveBeenCalledWith(
      localPath,
      { ALPHRED_SANDBOX_DIR: sandboxDir },
      {
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
      },
    );
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('reclones existing repositories when origin does not match the expected remote', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend-mirror.git');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github', async (_remote, path) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, '.git'), '');
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(fetchAll).not.toHaveBeenCalled();
    expect(cloneRepo).toHaveBeenCalledWith('https://github.com/acme/frontend.git', localPath, {
      ALPHRED_SANDBOX_DIR: sandboxDir,
    });
  });

  it('reclones existing repositories when origin is not configured', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath);

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github', async (_remote, path) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, '.git'), '');
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(fetchAll).not.toHaveBeenCalled();
    expect(cloneRepo).toHaveBeenCalledWith('https://github.com/acme/frontend.git', localPath, {
      ALPHRED_SANDBOX_DIR: sandboxDir,
    });
  });

  it('preserves existing repositories when origin lookup fails for execution reasons', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend.git');
    const markerPath = join(localPath, 'keep.txt');
    await writeFile(markerPath, 'keep');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github');

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
        provider,
        fetchAll,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
          PATH: '',
        },
      }),
    ).rejects.toThrow();

    const repository = getRepositoryByName(db, 'frontend');
    expect(repository).not.toBeNull();
    expect(repository?.cloneStatus).toBe('cloned');
    expect(repository?.localPath).toBe(localPath);
    await expect(access(markerPath)).resolves.toBeUndefined();
    expect(fetchAll).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('preserves clone status and local repository when fetch fails', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'github', 'acme', 'frontend');
    await initializeGitRepository(localPath, 'https://github.com/acme/frontend.git');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const { provider, cloneRepo } = createMockProvider('github');

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
        provider,
        fetchAll,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
        },
      }),
    ).rejects.toThrow('fetch failed');

    const repository = getRepositoryByName(db, 'frontend');
    expect(repository).not.toBeNull();
    expect(repository?.cloneStatus).toBe('cloned');
    expect(repository?.localPath).toBe(localPath);
    await expect(access(localPath)).resolves.toBeUndefined();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('marks clone status as error and removes partial directories when clone fails', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const expectedPath = join(sandboxDir, 'github', 'acme', 'frontend');
    const { provider } = createMockProvider('github', async (_remote, localPath) => {
      await mkdir(localPath, { recursive: true });
      await writeFile(join(localPath, '.git'), '');
      throw new Error('clone failed');
    });

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
        provider,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
        },
      }),
    ).rejects.toThrow('clone failed');

    const repository = getRepositoryByName(db, 'frontend');
    expect(repository).not.toBeNull();
    expect(repository?.cloneStatus).toBe('error');
    expect(repository?.localPath).toBe(expectedPath);
    await expect(access(expectedPath)).rejects.toThrow();
  });

  it('marks clone status as error when preparing the clone target fails', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const expectedPath = join(sandboxDir, 'github', 'acme', 'frontend');
    const { provider, cloneRepo } = createMockProvider('github');

    await writeFile(join(sandboxDir, 'github'), 'not-a-directory');

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
        provider,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
        },
      }),
    ).rejects.toThrow();

    const repository = getRepositoryByName(db, 'frontend');
    expect(repository).not.toBeNull();
    expect(repository?.cloneStatus).toBe('error');
    expect(repository?.localPath).toBe(expectedPath);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('ignores unsafe persisted localPath values and clones to the derived sandbox path', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const unsafeRoot = await createSandboxDir();
    cleanupPaths.add(unsafeRoot);
    const unsafePath = join(unsafeRoot, 'unsafe-repository-path');
    const unsafeMarkerPath = join(unsafePath, 'do-not-delete.txt');
    const expectedPath = join(sandboxDir, 'github', 'acme', 'frontend');

    await mkdir(unsafePath, { recursive: true });
    await writeFile(unsafeMarkerPath, 'keep');

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'error',
      localPath: unsafePath,
    });

    const { provider, cloneRepo } = createMockProvider('github', async (_remote, localPath) => {
      await mkdir(localPath, { recursive: true });
      await writeFile(join(localPath, '.git'), '');
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(cloneRepo).toHaveBeenCalledWith('https://github.com/acme/frontend.git', expectedPath, {
      ALPHRED_SANDBOX_DIR: sandboxDir,
    });
    expect(result.repository.localPath).toBe(expectedPath);
    await expect(access(unsafeMarkerPath)).resolves.toBeUndefined();
  });

  it('ignores persisted localPath symlinks that resolve outside the provider sandbox', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const unsafeRoot = await createSandboxDir();
    cleanupPaths.add(unsafeRoot);
    const expectedPath = join(sandboxDir, 'github', 'acme', 'frontend');
    const unsafePath = join(unsafeRoot, 'outside-repository');
    const unsafeMarkerPath = join(unsafePath, 'do-not-delete.txt');

    await initializeGitRepository(unsafePath, 'https://github.com/acme/frontend.git');
    await writeFile(unsafeMarkerPath, 'keep');
    await mkdir(dirname(expectedPath), { recursive: true });
    await symlink(unsafePath, expectedPath);

    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
      cloneStatus: 'cloned',
      localPath: expectedPath,
    });

    const fetchAll = vi.fn(async () => undefined);
    const { provider, cloneRepo } = createMockProvider('github', async (_remote, localPath) => {
      await mkdir(localPath, { recursive: true });
      await writeFile(join(localPath, '.git'), '');
    });

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'frontend',
        provider: 'github',
        remoteUrl: 'https://github.com/acme/frontend.git',
        remoteRef: 'acme/frontend',
      },
      provider,
      fetchAll,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(fetchAll).not.toHaveBeenCalled();
    expect(cloneRepo).toHaveBeenCalledWith('https://github.com/acme/frontend.git', expectedPath, {
      ALPHRED_SANDBOX_DIR: sandboxDir,
    });
    await expect(access(unsafeMarkerPath)).resolves.toBeUndefined();
  });

  it('rejects when repository identity does not match existing registry row', async () => {
    const db = createMigratedDb();
    insertRepository(db, {
      name: 'frontend',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/frontend.git',
      remoteRef: 'acme/frontend',
    });

    const { provider } = createMockProvider('github');

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend-mirror.git',
          remoteRef: 'acme/frontend-mirror',
        },
        provider,
      }),
    ).rejects.toThrow('remoteUrl mismatch');
  });

  it('rejects injected providers with mismatched repository identity', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const { provider, cloneRepo } = createMockProvider('github');
    const providerWithMismatchedConfig: ScmProvider = {
      ...provider,
      getConfig: () => ({
        kind: 'github',
        repo: 'acme/frontend-mirror',
      }),
    };

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
        provider: providerWithMismatchedConfig,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
        },
      }),
    ).rejects.toThrow('Provider identity mismatch');

    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('does not persist repository rows when remoteRef validation fails', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme',
        },
      }),
    ).rejects.toThrow('Invalid GitHub remoteRef');

    expect(getRepositoryByName(db, 'frontend')).toBeNull();
  });

  it('rejects remoteRef owner/repository that does not match remoteUrl', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'frontend',
          provider: 'github',
          remoteUrl: 'https://github.com/acme/frontend.git',
          remoteRef: 'acme/frontend-mirror',
        },
      }),
    ).rejects.toThrow('Owner/repository must match remoteUrl repository acme/frontend');

    expect(getRepositoryByName(db, 'frontend')).toBeNull();
  });

  it('rejects hostless remoteRef for GitHub Enterprise remotes', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'enterprise-frontend',
          provider: 'github',
          remoteUrl: 'https://github.example.com/acme/frontend.git',
          remoteRef: 'acme/frontend',
        },
      }),
    ).rejects.toThrow('Expected github.example.com/owner/repo');

    expect(getRepositoryByName(db, 'enterprise-frontend')).toBeNull();
  });

  it('rejects enterprise remoteRef host that does not match remoteUrl host', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'enterprise-frontend',
          provider: 'github',
          remoteUrl: 'https://github.example.com/acme/frontend.git',
          remoteRef: 'github.other.example/acme/frontend',
        },
      }),
    ).rejects.toThrow('Host must match remoteUrl host github.example.com');

    expect(getRepositoryByName(db, 'enterprise-frontend')).toBeNull();
  });

  it('rejects Azure DevOps remotes hosted outside supported Azure domains', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'azure-frontend',
          provider: 'azure-devops',
          remoteUrl: 'https://example.com/acme/platform/_git/frontend',
          remoteRef: 'acme/platform/frontend',
        },
      }),
    ).rejects.toThrow('Host must be dev.azure.com, ssh.dev.azure.com, or *.visualstudio.com');

    expect(getRepositoryByName(db, 'azure-frontend')).toBeNull();
  });

  it('rejects Azure DevOps remoteRef values that do not match remoteUrl repository identity', async () => {
    const db = createMigratedDb();

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'azure-frontend',
          provider: 'azure-devops',
          remoteUrl: 'https://dev.azure.com/acme/platform/_git/frontend',
          remoteRef: 'acme/platform/frontend-mirror',
        },
      }),
    ).rejects.toThrow('Organization/project/repository must match remoteUrl repository acme/platform/frontend');

    expect(getRepositoryByName(db, 'azure-frontend')).toBeNull();
  });

  it('accepts Azure DevOps remoteUrl values with encoded path segments', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const expectedPath = join(sandboxDir, 'azure-devops', 'acme', 'My Project', 'frontend');
    const { provider, cloneRepo } = createMockProvider('azure-devops');

    const result = await ensureRepositoryClone({
      db,
      repository: {
        name: 'azure-frontend',
        provider: 'azure-devops',
        remoteUrl: 'https://dev.azure.com/acme/My%20Project/_git/frontend',
        remoteRef: 'acme/My Project/frontend',
      },
      provider,
      environment: {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    });

    expect(result.action).toBe('cloned');
    expect(cloneRepo).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/My%20Project/_git/frontend',
      expectedPath,
      {
        ALPHRED_SANDBOX_DIR: sandboxDir,
      },
    );
  });

  it('rejects existing Azure DevOps repositories with unsupported remote hosts before fetch', async () => {
    const db = createMigratedDb();
    const sandboxDir = await createSandboxDir();
    cleanupPaths.add(sandboxDir);
    const localPath = join(sandboxDir, 'azure-devops', 'acme', 'platform', 'frontend');
    await mkdir(localPath, { recursive: true });
    await writeFile(join(localPath, '.git'), '');

    insertRepository(db, {
      name: 'azure-frontend',
      provider: 'azure-devops',
      remoteUrl: 'https://example.com/acme/platform/_git/frontend',
      remoteRef: 'acme/platform/frontend',
      localPath,
      cloneStatus: 'cloned',
    });

    const fetchAll = vi.fn(async () => undefined);

    await expect(
      ensureRepositoryClone({
        db,
        repository: {
          name: 'azure-frontend',
          provider: 'azure-devops',
          remoteUrl: 'https://example.com/acme/platform/_git/frontend',
          remoteRef: 'acme/platform/frontend',
        },
        fetchAll,
        environment: {
          ALPHRED_SANDBOX_DIR: sandboxDir,
        },
      }),
    ).rejects.toThrow('Host must be dev.azure.com, ssh.dev.azure.com, or *.visualstudio.com');

    expect(fetchAll).not.toHaveBeenCalled();
  });
});
