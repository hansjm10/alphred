import { beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeBootstrapError,
  initializeClaudeSdkBootstrap,
  resetClaudeSdkBootstrapCache,
} from './claudeSdkBootstrap.js';

describe('claude sdk bootstrap', () => {
  beforeEach(() => {
    resetClaudeSdkBootstrapCache();
  });

  it('prefers CLAUDE_API_KEY and CLAUDE_BASE_URL when both provider-specific and Anthropic env vars are set', () => {
    const bootstrap = initializeClaudeSdkBootstrap({
      env: {
        CLAUDE_API_KEY: '  sk-claude  ',
        ANTHROPIC_API_KEY: 'sk-anthropic',
        CLAUDE_BASE_URL: 'https://claude-proxy.example.com/v1',
        ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example.com/v1',
      },
    });

    expect(bootstrap.authMode).toBe('api_key');
    expect(bootstrap.apiKey).toBe('sk-claude');
    expect(bootstrap.apiKeySource).toBe('CLAUDE_API_KEY');
    expect(bootstrap.baseUrl).toBe('https://claude-proxy.example.com/v1');
    expect(bootstrap.model).toBe('claude-3-7-sonnet-latest');
  });

  it('accepts ANTHROPIC_API_KEY fallback and validates model/base URL overrides', () => {
    const bootstrap = initializeClaudeSdkBootstrap({
      env: {
        ANTHROPIC_API_KEY: 'sk-anthropic',
        ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example.com/v1',
        CLAUDE_MODEL: 'claude-3-5-haiku-latest',
      },
    });

    expect(bootstrap.authMode).toBe('api_key');
    expect(bootstrap.apiKey).toBe('sk-anthropic');
    expect(bootstrap.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(bootstrap.baseUrl).toBe('https://anthropic-proxy.example.com/v1');
    expect(bootstrap.model).toBe('claude-3-5-haiku-latest');
  });

  it('throws deterministic missing-auth errors when no supported API key env var is configured', () => {
    expect(() => initializeClaudeSdkBootstrap({ env: {} })).toThrowError(ClaudeBootstrapError);

    try {
      initializeClaudeSdkBootstrap({ env: {} });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeBootstrapError);
      const typedError = error as ClaudeBootstrapError;
      expect(typedError.code).toBe('CLAUDE_BOOTSTRAP_MISSING_AUTH');
      expect(typedError.message).toBe(
        'Claude provider requires an API key via CLAUDE_API_KEY or ANTHROPIC_API_KEY.',
      );
      expect(typedError.details).toEqual({
        requestedAuthMode: 'api_key',
        checkedEnvVars: ['CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'],
      });
    }
  });

  it('throws deterministic errors when CLAUDE_AUTH_MODE requests unsupported CLI-session auth', () => {
    expect(() => initializeClaudeSdkBootstrap({
      env: {
        CLAUDE_AUTH_MODE: 'cli_session',
      },
    })).toThrowError(ClaudeBootstrapError);

    try {
      initializeClaudeSdkBootstrap({
        env: {
          CLAUDE_AUTH_MODE: 'cli_session',
        },
      });
      throw new Error('Expected bootstrap to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeBootstrapError);
      const typedError = error as ClaudeBootstrapError;
      expect(typedError.code).toBe('CLAUDE_BOOTSTRAP_UNSUPPORTED_AUTH_MODE');
      expect(typedError.details).toEqual({
        requestedAuthMode: 'cli_session',
        supportedAuthModes: ['api_key'],
      });
    }
  });

  it('throws deterministic errors for malformed auth mode, endpoint, and key/model configuration', () => {
    for (const env of [
      { CLAUDE_AUTH_MODE: 'oauth' },
      { CLAUDE_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'ftp://anthropic.example.com' },
      { CLAUDE_API_KEY: 'sk-test', CLAUDE_BASE_URL: 'not-a-url' },
      { CLAUDE_API_KEY: 'sk-test', CLAUDE_MODEL: '   ' },
      { ANTHROPIC_API_KEY: '   ' },
      { CLAUDE_API_KEY: 'sk-test', CLAUDE_BASE_URL: '   ' },
    ]) {
      expect(() => initializeClaudeSdkBootstrap({ env })).toThrowError(ClaudeBootstrapError);
    }
  });
});
