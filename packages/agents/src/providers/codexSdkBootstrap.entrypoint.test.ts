import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexOptions } from '@openai/codex-sdk';

const { codexConstructorMock, createRequireResolveMock, existsSyncMock } = vi.hoisted(() => ({
  codexConstructorMock: vi.fn(function MockCodex(_options: CodexOptions) {
    return {};
  }),
  createRequireResolveMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexConstructorMock,
}));

vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  return {
    ...actual,
    createRequire: () => ({
      resolve: createRequireResolveMock,
    }),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

import {
  CodexBootstrapError,
  initializeCodexSdkBootstrap,
  resetCodexSdkBootstrapCache,
} from './codexSdkBootstrap.js';

describe('codex sdk bootstrap entrypoint resolution', () => {
  beforeEach(() => {
    codexConstructorMock.mockReset();
    createRequireResolveMock.mockReset();
    existsSyncMock.mockReset();
    resetCodexSdkBootstrapCache();
  });

  it('discovers the sdk package root from the exported entrypoint', () => {
    const sdkEntrypointPath = '/virtual/node_modules/@openai/codex-sdk/dist/index.js';
    const sdkPackageJsonPath = '/virtual/node_modules/@openai/codex-sdk/package.json';
    const expectedBinaryPath = '/virtual/node_modules/@openai/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex';

    createRequireResolveMock.mockReturnValue(sdkEntrypointPath);
    existsSyncMock.mockImplementation((path: string) => (
      path === sdkPackageJsonPath || path === expectedBinaryPath
    ));

    const bootstrap = initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-test' },
      platform: 'linux',
      arch: 'x64',
    });

    expect(createRequireResolveMock).toHaveBeenCalledWith('@openai/codex-sdk', {
      conditions: new Set(['import', 'node', 'default']),
    });
    expect(bootstrap.codexBinaryPath).toBe(expectedBinaryPath);
    expect(codexConstructorMock).toHaveBeenCalledWith({
      codexPathOverride: expectedBinaryPath,
      apiKey: 'sk-test',
      baseUrl: undefined,
    });
  });

  it('throws deterministic errors when the sdk package cannot be resolved', () => {
    const resolutionError = new Error('Cannot find module @openai/codex-sdk');
    createRequireResolveMock.mockImplementation(() => {
      throw resolutionError;
    });

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
      expect(typedError.cause).toBe(resolutionError);
    }
  });

  it('throws deterministic errors when no package.json is found above the sdk entrypoint', () => {
    const sdkEntrypointPath = '/virtual/node_modules/@openai/codex-sdk/dist/index.js';
    createRequireResolveMock.mockReturnValue(sdkEntrypointPath);
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
        'Codex provider could not determine the @openai/codex-sdk package root from its exported entry.',
      );
      expect(typedError.details).toEqual({
        sdkEntrypointPath,
      });
    }
  });
});
