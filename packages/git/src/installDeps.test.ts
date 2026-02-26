import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  installDependencies,
  runInstallCommand,
  type InstallOutput,
} from './installDeps.js';

function createFakeChildProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    killMock: Mock<(signal?: NodeJS.Signals | number) => boolean>;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.killMock = vi.fn((signal?: NodeJS.Signals | number) => {
    void signal;
    return true;
  });
  process.kill = signal => process.killMock(signal);
  return process;
}

async function createTempWorktree(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alphred-install-deps-'));
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('installDependencies', () => {
  it('skips installation when skipInstall option is true', async () => {
    const worktreePath = await createTempWorktree();
    const runCommand = vi.fn(async () => undefined);

    await expect(
      installDependencies({
        worktreePath,
        skipInstall: true,
        runCommand,
      }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'skip_option',
    });
    expect(runCommand).not.toHaveBeenCalled();

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('skips installation when ALPHRED_SKIP_INSTALL=1', async () => {
    const worktreePath = await createTempWorktree();
    await writeFile(join(worktreePath, 'pnpm-lock.yaml'), 'lock');
    const runCommand = vi.fn(async () => undefined);

    await expect(
      installDependencies({
        worktreePath,
        environment: {
          ALPHRED_SKIP_INSTALL: '1',
        },
        runCommand,
      }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'skip_env',
    });
    expect(runCommand).not.toHaveBeenCalled();

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('uses ALPHRED_INSTALL_CMD override when provided', async () => {
    const worktreePath = await createTempWorktree();
    const runCommand = vi.fn(async () => undefined);

    const result = await installDependencies({
      worktreePath,
      environment: {
        ALPHRED_INSTALL_CMD: 'pnpm install --frozen-lockfile',
      },
      runCommand,
    });

    expect(result).toEqual({
      status: 'installed',
      source: 'override',
      command: 'pnpm install --frozen-lockfile',
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          source: 'override',
          command: 'pnpm install --frozen-lockfile',
          shell: true,
        }),
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      }),
    );

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('selects lockfile command using deterministic priority order', async () => {
    const worktreePath = await createTempWorktree();
    await writeFile(join(worktreePath, 'package-lock.json'), '{}');
    await writeFile(join(worktreePath, 'yarn.lock'), '# lock');
    const runCommand = vi.fn(async () => undefined);

    const result = await installDependencies({
      worktreePath,
      runCommand,
    });

    expect(result).toEqual({
      status: 'installed',
      source: 'lockfile',
      command: 'yarn install',
      lockfile: 'yarn.lock',
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          command: 'yarn',
          args: ['install'],
          lockfile: 'yarn.lock',
          shell: false,
        }),
      }),
    );

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('uses ALPHRED_INSTALL_TIMEOUT_MS when configured', async () => {
    const worktreePath = await createTempWorktree();
    await writeFile(join(worktreePath, 'pnpm-lock.yaml'), 'lock');
    const runCommand = vi.fn(async () => undefined);

    await installDependencies({
      worktreePath,
      environment: {
        ALPHRED_INSTALL_TIMEOUT_MS: '12',
      },
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 12,
      }),
    );

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('throws when ALPHRED_INSTALL_TIMEOUT_MS is invalid', async () => {
    const worktreePath = await createTempWorktree();
    await writeFile(join(worktreePath, 'pnpm-lock.yaml'), 'lock');

    await expect(
      installDependencies({
        worktreePath,
        environment: {
          ALPHRED_INSTALL_TIMEOUT_MS: 'bad-value',
        },
      }),
    ).rejects.toThrow('ALPHRED_INSTALL_TIMEOUT_MS must be a positive integer.');

    await rm(worktreePath, { recursive: true, force: true });
  });

  it('returns no_lockfile when no supported lockfile exists', async () => {
    const worktreePath = await createTempWorktree();
    const runCommand = vi.fn(async () => undefined);

    await expect(
      installDependencies({
        worktreePath,
        runCommand,
      }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'no_lockfile',
    });
    expect(runCommand).not.toHaveBeenCalled();

    await rm(worktreePath, { recursive: true, force: true });
  });
});

describe('runInstallCommand', () => {
  it('streams command output and resolves on successful exit', async () => {
    const childProcess = createFakeChildProcess();
    const outputs: InstallOutput[] = [];
    const runPromise = runInstallCommand({
      command: {
        source: 'lockfile',
        command: 'pnpm',
        args: ['install'],
        displayCommand: 'pnpm install',
        shell: false,
      },
      cwd: '/tmp/worktree',
      environment: {},
      timeoutMs: 1000,
      onOutput: output => outputs.push(output),
      spawnCommand: () => childProcess,
    });

    childProcess.stdout.write('installing');
    childProcess.stderr.write('warning');
    childProcess.emit('close', 0, null);

    await expect(runPromise).resolves.toBeUndefined();
    expect(outputs).toEqual([
      {
        stream: 'stdout',
        chunk: 'installing',
      },
      {
        stream: 'stderr',
        chunk: 'warning',
      },
    ]);
  });

  it('rejects on non-zero exit code', async () => {
    const childProcess = createFakeChildProcess();
    const runPromise = runInstallCommand({
      command: {
        source: 'lockfile',
        command: 'pnpm',
        args: ['install'],
        displayCommand: 'pnpm install',
        shell: false,
      },
      cwd: '/tmp/worktree',
      environment: {},
      timeoutMs: 1000,
      onOutput: () => undefined,
      spawnCommand: () => childProcess,
    });

    childProcess.emit('close', 1, null);

    await expect(runPromise).rejects.toThrow('Install command "pnpm install" failed with exit code 1.');
  });

  it('includes signal in error message when process exits from a signal', async () => {
    const childProcess = createFakeChildProcess();
    const runPromise = runInstallCommand({
      command: {
        source: 'lockfile',
        command: 'pnpm',
        args: ['install'],
        displayCommand: 'pnpm install',
        shell: false,
      },
      cwd: '/tmp/worktree',
      environment: {},
      timeoutMs: 1000,
      onOutput: () => undefined,
      spawnCommand: () => childProcess,
    });

    childProcess.emit('close', null, 'SIGTERM');

    await expect(runPromise).rejects.toThrow(
      'Install command "pnpm install" failed with exit code null (signal: SIGTERM).',
    );
  });

  it('kills and rejects when install times out', async () => {
    vi.useFakeTimers();
    const childProcess = createFakeChildProcess();
    childProcess.killMock.mockImplementation(signal => {
      childProcess.emit('close', null, signal === undefined ? null : String(signal));
      return true;
    });

    const runPromise = runInstallCommand({
      command: {
        source: 'override',
        command: 'pnpm install',
        args: [],
        displayCommand: 'pnpm install',
        shell: true,
      },
      cwd: '/tmp/worktree',
      environment: {},
      timeoutMs: 50,
      onOutput: () => undefined,
      spawnCommand: () => childProcess,
    });

    const rejection = expect(runPromise).rejects.toThrow('Install command "pnpm install" timed out after 50ms.');
    await vi.advanceTimersByTimeAsync(60);

    await rejection;
    expect(childProcess.killMock).toHaveBeenCalledWith('SIGTERM');
  });
});
