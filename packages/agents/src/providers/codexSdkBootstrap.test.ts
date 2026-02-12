import type { Codex, CodexOptions } from '@openai/codex-sdk';
import { describe, expect, it, vi } from 'vitest';
import { CodexBootstrapError, initializeCodexSdkBootstrap } from './codexSdkBootstrap.js';

const linuxBinaryPath = '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex';

function createMockClient(): Codex {
  return {} as Codex;
}

describe('codex sdk bootstrap', () => {
  it('prefers CODEX_API_KEY and skips CLI session checks when API key auth is configured', () => {
    const checkCliSession = vi.fn();
    const createClient = vi.fn((_options: CodexOptions) => createMockClient());

    const bootstrap = initializeCodexSdkBootstrap({
      env: {
        CODEX_API_KEY: '  sk-codex  ',
        OPENAI_API_KEY: 'sk-openai',
      },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession,
      createClient,
    });

    expect(bootstrap.authMode).toBe('api_key');
    expect(bootstrap.apiKey).toBe('sk-codex');
    expect(bootstrap.model).toBe('gpt-5-codex');
    expect(bootstrap.codexHome).toBe('/home/tester/.codex');
    expect(checkCliSession).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: linuxBinaryPath,
      apiKey: 'sk-codex',
      baseUrl: undefined,
    });
  });

  it('accepts OPENAI_API_KEY as API key fallback and validates model/base URL overrides', () => {
    const createClient = vi.fn((_options: CodexOptions) => createMockClient());

    const bootstrap = initializeCodexSdkBootstrap({
      env: {
        OPENAI_API_KEY: 'sk-openai',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        CODEX_MODEL: 'gpt-5-codex-mini',
      },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession: () => ({ status: 'not_authenticated' }),
      createClient,
    });

    expect(bootstrap.authMode).toBe('api_key');
    expect(bootstrap.apiKey).toBe('sk-openai');
    expect(bootstrap.baseUrl).toBe('https://proxy.example.com/v1');
    expect(bootstrap.model).toBe('gpt-5-codex-mini');
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: linuxBinaryPath,
      apiKey: 'sk-openai',
      baseUrl: 'https://proxy.example.com/v1',
    });
  });

  it('detects and uses CLI-session auth when no API key is configured', () => {
    const checkCliSession = vi.fn((_binaryPath: string, _env: NodeJS.ProcessEnv) => ({ status: 'authenticated' as const }));
    const createClient = vi.fn((_options: CodexOptions) => createMockClient());

    const bootstrap = initializeCodexSdkBootstrap({
      env: {},
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession,
      createClient,
    });

    expect(bootstrap.authMode).toBe('cli_session');
    expect(bootstrap.apiKey).toBeUndefined();
    expect(checkCliSession).toHaveBeenCalledWith(
      linuxBinaryPath,
      expect.objectContaining({
        CODEX_HOME: '/home/tester/.codex',
      }),
    );
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: linuxBinaryPath,
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it('throws deterministic missing-auth errors when no API key and no CLI session are available', () => {
    expect(() => initializeCodexSdkBootstrap({
      env: {},
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession: () => ({ status: 'not_authenticated' }),
      createClient: (_options: CodexOptions) => createMockClient(),
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: {},
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === linuxBinaryPath,
        checkCliSession: () => ({ status: 'not_authenticated' }),
        createClient: (_options: CodexOptions) => createMockClient(),
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_MISSING_AUTH');
      expect(typedError.message).toBe(
        'Codex provider requires either an API key or an existing Codex CLI login session.',
      );
    }
  });

  it('throws deterministic errors when CLI-session discovery fails', () => {
    expect(() => initializeCodexSdkBootstrap({
      env: {},
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession: () => ({ status: 'error', message: 'Error checking login status: parse failure' }),
      createClient: (_options: CodexOptions) => createMockClient(),
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: {},
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === linuxBinaryPath,
        checkCliSession: () => ({ status: 'error', message: 'Error checking login status: parse failure' }),
        createClient: (_options: CodexOptions) => createMockClient(),
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_SESSION_CHECK_FAILED');
      expect(typedError.message).toBe('Codex provider could not verify Codex CLI login status.');
    }
  });

  it('throws deterministic errors for invalid endpoint/model configuration', () => {
    for (const env of [
      { CODEX_API_KEY: 'sk-test', OPENAI_BASE_URL: 'ftp://proxy.example.com' },
      { CODEX_API_KEY: 'sk-test', CODEX_MODEL: '   ' },
      { CODEX_API_KEY: '   ' },
    ]) {
      expect(() => initializeCodexSdkBootstrap({
        env,
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === linuxBinaryPath,
        checkCliSession: () => ({ status: 'not_authenticated' }),
        createClient: (_options: CodexOptions) => createMockClient(),
      })).toThrowError(CodexBootstrapError);
    }
  });
});
