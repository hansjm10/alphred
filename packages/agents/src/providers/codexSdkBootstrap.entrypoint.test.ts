import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexOptions } from '@openai/codex-sdk';

const { codexConstructorMock, existsSyncMock } = vi.hoisted(() => ({
  codexConstructorMock: vi.fn(function MockCodex(_options: CodexOptions) {
    return {};
  }),
  existsSyncMock: vi.fn(),
}));
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexConstructorMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import {
  CodexBootstrapError,
  initializeCodexSdkBootstrap,
  resetCodexSdkBootstrapCache,
} from './codexSdkBootstrap.js';

function resolveRuntimeTargetTriple(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'linux' || platform === 'android') {
    if (arch === 'x64') {
      return 'x86_64-unknown-linux-musl';
    }
    if (arch === 'arm64') {
      return 'aarch64-unknown-linux-musl';
    }
  }

  if (platform === 'darwin') {
    if (arch === 'x64') {
      return 'x86_64-apple-darwin';
    }
    if (arch === 'arm64') {
      return 'aarch64-apple-darwin';
    }
  }

  if (platform === 'win32') {
    if (arch === 'x64') {
      return 'x86_64-pc-windows-msvc';
    }
    if (arch === 'arm64') {
      return 'aarch64-pc-windows-msvc';
    }
  }

  return undefined;
}

describe('codex sdk bootstrap entrypoint resolution', () => {
  beforeEach(() => {
    codexConstructorMock.mockReset();
    existsSyncMock.mockReset();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
    resetCodexSdkBootstrapCache();
  });

  it('discovers the sdk package root from working-directory lookup', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/virtual/apps/dashboard');
    const sdkPackageJsonPath = '/virtual/apps/dashboard/node_modules/@openai/codex-sdk/package.json';
    const expectedBinaryPath = '/virtual/apps/dashboard/node_modules/@openai/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex';

    existsSyncMock.mockImplementation((path: string) => (
      path === sdkPackageJsonPath || path === expectedBinaryPath
    ));

    try {
      const bootstrap = initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform: 'linux',
        arch: 'x64',
      });

      expect(bootstrap.codexBinaryPath).toBe(expectedBinaryPath);
      expect(codexConstructorMock).toHaveBeenCalledWith({
        codexPathOverride: expectedBinaryPath,
        apiKey: 'sk-test',
        baseUrl: undefined,
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('throws deterministic errors when the sdk package cannot be resolved', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/virtual/apps/dashboard');
    existsSyncMock.mockReturnValue(false);

    expect(() => initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-test' },
      platform: 'linux',
      arch: 'x64',
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform: 'linux',
        arch: 'x64',
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_INVALID_CONFIG');
      expect(typedError.message).toBe(
        'Codex provider could not resolve @openai/codex-sdk from the current runtime.',
      );
      expect(typedError.details).toEqual({
        checkedRoots: expect.arrayContaining(['/virtual/apps/dashboard']),
      });
      expect(typedError.cause).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('uses the default CLI status check and maps "Not logged in" to missing-auth', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stderr: 'Not logged in. Run "codex login".',
    });

    expect(() => initializeCodexSdkBootstrap({
      env: {
        TRACE_ID: 'req-123',
        OPTIONAL_DEBUG_FLAG: undefined,
      },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
    })).toThrowError(CodexBootstrapError);

    const spawnOptions = spawnSyncMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv; encoding: string };
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
      ['login', 'status'],
      expect.objectContaining({
        encoding: 'utf8',
      }),
    );
    expect(spawnOptions.env.CODEX_HOME).toBe('/home/tester/.codex');
    expect(spawnOptions.env.TRACE_ID).toBe('req-123');
    expect('OPTIONAL_DEBUG_FLAG' in spawnOptions.env).toBe(false);

    try {
      initializeCodexSdkBootstrap({
        env: {
          TRACE_ID: 'req-123',
        },
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_MISSING_AUTH');
    }
  });

  it('uses the default CLI status check and accepts an authenticated CLI session', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: '',
    });

    const bootstrap = initializeCodexSdkBootstrap({
      env: {},
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
    });

    expect(bootstrap.authMode).toBe('cli_session');
    expect(codexConstructorMock).toHaveBeenCalledWith({
      codexPathOverride: '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it('uses the default CLI status check and surfaces command execution failures', () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stderr: '',
      error: new Error('spawn ENOENT'),
    });

    try {
      initializeCodexSdkBootstrap({
        env: {},
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_SESSION_CHECK_FAILED');
      expect(typedError.details).toMatchObject({
        message: 'spawn ENOENT',
      });
    }
  });

  it('uses the default CLI status check and falls back to unknown-status message when stderr is empty', () => {
    spawnSyncMock.mockReturnValue({
      status: 42,
      stderr: '   ',
    });

    try {
      initializeCodexSdkBootstrap({
        env: {},
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex',
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_SESSION_CHECK_FAILED');
      expect(typedError.details).toMatchObject({
        message: 'Unknown failure while checking Codex CLI login status.',
      });
    }
  });

  it('caches the bootstrap result when initialized without overrides', () => {
    const runtimeTargetTriple = resolveRuntimeTargetTriple(process.platform, process.arch);
    if (!runtimeTargetTriple) {
      return;
    }

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/virtual/apps/dashboard');
    const sdkPackageJsonPath = '/virtual/apps/dashboard/node_modules/@openai/codex-sdk/package.json';
    const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const expectedBinaryPath = `/virtual/apps/dashboard/node_modules/@openai/codex-sdk/vendor/${runtimeTargetTriple}/codex/${binaryName}`;

    try {
      vi.stubEnv('CODEX_API_KEY', 'sk-cached');
      existsSyncMock.mockImplementation((path: string) => (
        path === sdkPackageJsonPath || path === expectedBinaryPath
      ));

      const firstBootstrap = initializeCodexSdkBootstrap();
      const secondBootstrap = initializeCodexSdkBootstrap();

      expect(secondBootstrap).toBe(firstBootstrap);
      expect(codexConstructorMock).toHaveBeenCalledTimes(1);
      expect(codexConstructorMock).toHaveBeenCalledWith({
        codexPathOverride: expectedBinaryPath,
        apiKey: 'sk-cached',
        baseUrl: undefined,
      });
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
