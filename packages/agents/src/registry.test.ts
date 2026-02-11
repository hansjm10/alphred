import { describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRunOptions } from '@alphred/shared';
import type { AgentProvider } from './provider.js';
import { ClaudeProvider, CodexProvider } from './index.js';
import {
  UnknownAgentProviderError,
  createAgentProviderResolver,
  defaultAgentProviderRegistry,
  resolveAgentProvider,
} from './registry.js';

class FakeProvider implements AgentProvider {
  readonly name = 'fake';

  async *run(_prompt: string, _options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    yield {
      type: 'result',
      content: '',
      timestamp: Date.now(),
    };
  }
}

describe('agent provider registry', () => {
  it('resolves default claude and codex providers', () => {
    const claudeProvider = resolveAgentProvider('claude');
    const codexProvider = resolveAgentProvider('codex');

    expect(claudeProvider).toBeInstanceOf(ClaudeProvider);
    expect(codexProvider).toBeInstanceOf(CodexProvider);
  });

  it('throws deterministic typed error for unknown provider', () => {
    expect(() => resolveAgentProvider('unknown-provider')).toThrowError(UnknownAgentProviderError);

    try {
      resolveAgentProvider('unknown-provider');
      throw new Error('Expected unknown provider to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownAgentProviderError);

      const typedError = error as UnknownAgentProviderError;
      expect(typedError.code).toBe('UNKNOWN_AGENT_PROVIDER');
      expect(typedError.providerName).toBe('unknown-provider');
      expect(typedError.availableProviders).toEqual(['claude', 'codex']);
      expect(typedError.message).toBe(
        'Unknown agent provider "unknown-provider". Available providers: claude, codex.',
      );
    }
  });

  it('supports a generic custom registry', () => {
    const fakeProvider = new FakeProvider();
    const resolver = createAgentProviderResolver({
      claude: new ClaudeProvider(),
      codex: new CodexProvider(),
      fake: fakeProvider,
    });

    expect(resolver('fake')).toBe(fakeProvider);
  });

  it('exposes a frozen default registry for deterministic wiring', () => {
    expect(Object.isFrozen(defaultAgentProviderRegistry)).toBe(true);
    expect(defaultAgentProviderRegistry.claude).toBeInstanceOf(ClaudeProvider);
    expect(defaultAgentProviderRegistry.codex).toBeInstanceOf(CodexProvider);
  });
});
