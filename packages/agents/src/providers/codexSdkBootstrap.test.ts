import type { Codex, CodexOptions } from '@openai/codex-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodexBootstrapError,
  initializeCodexSdkBootstrap,
  resetCodexSdkBootstrapCache,
} from './codexSdkBootstrap.js';

const linuxBinaryPath = '/opt/codex-sdk/vendor/x86_64-unknown-linux-musl/codex/codex';

function createMockClient(): Codex {
  return {} as Codex;
}

describe('codex sdk bootstrap', () => {
  beforeEach(() => {
    resetCodexSdkBootstrapCache();
  });

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
      { CODEX_API_KEY: 'sk-test', OPENAI_BASE_URL: 'not-a-url' },
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

  it('passes configured CODEX_HOME into CLI session checks', () => {
    const checkCliSession = vi.fn((_binaryPath: string, _env: NodeJS.ProcessEnv) => ({ status: 'authenticated' as const }));

    initializeCodexSdkBootstrap({
      env: {
        CODEX_HOME: '  /srv/codex-auth  ',
        HOME: '/home/tester',
      },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/ignored',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      checkCliSession,
      createClient: (_options: CodexOptions) => createMockClient(),
    });

    expect(checkCliSession).toHaveBeenCalledWith(
      linuxBinaryPath,
      expect.objectContaining({
        CODEX_HOME: '/srv/codex-auth',
        HOME: '/home/tester',
      }),
    );
  });

  it('resolves Windows arm64 binaries to codex.exe', () => {
    const windowsBinaryPath = '/opt/codex-sdk/vendor/aarch64-pc-windows-msvc/codex/codex.exe';
    const createClient = vi.fn((_options: CodexOptions) => createMockClient());

    const bootstrap = initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-win' },
      platform: 'win32',
      arch: 'arm64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === windowsBinaryPath,
      createClient,
    });

    expect(bootstrap.codexBinaryPath).toBe(windowsBinaryPath);
    expect(createClient).toHaveBeenCalledWith({
      codexPathOverride: windowsBinaryPath,
      apiKey: 'sk-win',
      baseUrl: undefined,
    });
  });

  it.each([
    {
      platform: 'linux' as const,
      arch: 'arm64',
      binaryPath: '/opt/codex-sdk/vendor/aarch64-unknown-linux-musl/codex/codex',
    },
    {
      platform: 'darwin' as const,
      arch: 'x64',
      binaryPath: '/opt/codex-sdk/vendor/x86_64-apple-darwin/codex/codex',
    },
    {
      platform: 'darwin' as const,
      arch: 'arm64',
      binaryPath: '/opt/codex-sdk/vendor/aarch64-apple-darwin/codex/codex',
    },
    {
      platform: 'win32' as const,
      arch: 'x64',
      binaryPath: '/opt/codex-sdk/vendor/x86_64-pc-windows-msvc/codex/codex.exe',
    },
  ])(
    'resolves $platform/$arch binaries to bundled codex executable path',
    ({ platform, arch, binaryPath }) => {
      const createClient = vi.fn((_options: CodexOptions) => createMockClient());

      const bootstrap = initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform,
        arch,
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === binaryPath,
        createClient,
      });

      expect(bootstrap.codexBinaryPath).toBe(binaryPath);
      expect(createClient).toHaveBeenCalledWith({
        codexPathOverride: binaryPath,
        apiKey: 'sk-test',
        baseUrl: undefined,
      });
    },
  );

  it('throws deterministic errors for unsupported platform and architecture combinations', () => {
    expect(() => initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-test' },
      platform: 'freebsd',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: () => true,
      createClient: (_options: CodexOptions) => createMockClient(),
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform: 'freebsd',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: () => true,
        createClient: (_options: CodexOptions) => createMockClient(),
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_UNSUPPORTED_PLATFORM');
      expect(typedError.details).toEqual({
        platform: 'freebsd',
        arch: 'x64',
      });
    }
  });

  it('throws deterministic errors when the bundled codex binary is missing', () => {
    expect(() => initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-test' },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: () => false,
      createClient: (_options: CodexOptions) => createMockClient(),
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: () => false,
        createClient: (_options: CodexOptions) => createMockClient(),
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_INVALID_CONFIG');
      expect(typedError.message).toContain('could not find the bundled codex binary');
      expect(typedError.details).toEqual({
        binaryPath: linuxBinaryPath,
      });
    }
  });

  it('wraps sdk-client initialization failures with deterministic metadata', () => {
    const clientInitError = new Error('mock client init failure');

    expect(() => initializeCodexSdkBootstrap({
      env: { CODEX_API_KEY: 'sk-test' },
      platform: 'linux',
      arch: 'x64',
      getHomedir: () => '/home/tester',
      resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
      fileExists: (path: string) => path === linuxBinaryPath,
      createClient: () => {
        throw clientInitError;
      },
    })).toThrowError(CodexBootstrapError);

    try {
      initializeCodexSdkBootstrap({
        env: { CODEX_API_KEY: 'sk-test' },
        platform: 'linux',
        arch: 'x64',
        getHomedir: () => '/home/tester',
        resolveSdkPackageJsonPath: () => '/opt/codex-sdk/package.json',
        fileExists: (path: string) => path === linuxBinaryPath,
        createClient: () => {
          throw clientInitError;
        },
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CodexBootstrapError);
      const typedError = error as CodexBootstrapError;
      expect(typedError.code).toBe('CODEX_BOOTSTRAP_CLIENT_INIT_FAILED');
      expect(typedError.details).toEqual({
        authMode: 'api_key',
        codexBinaryPath: linuxBinaryPath,
      });
      expect(typedError.cause).toBe(clientInitError);
    }
  });
});
