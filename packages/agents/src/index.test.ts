import { describe, expect, it } from 'vitest';
import * as agents from './index.js';

describe('agents index exports', () => {
  it('re-exports provider helpers, provider classes, and registry APIs', () => {
    expect(typeof agents.createProviderEvent).toBe('function');
    expect(typeof agents.ClaudeProvider).toBe('function');
    expect(typeof agents.CodexProvider).toBe('function');
    expect(typeof agents.CodexProviderError).toBe('function');
    expect(typeof agents.createAgentProviderResolver).toBe('function');
    expect(typeof agents.resolveAgentProvider).toBe('function');
    expect(typeof agents.UnknownAgentProviderError).toBe('function');
    expect(typeof agents.defaultAgentProviderRegistry).toBe('object');
  });
});
