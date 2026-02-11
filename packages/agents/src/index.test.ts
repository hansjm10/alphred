import { describe, expect, it } from 'vitest';
import * as agents from './index.js';

describe('agents index exports', () => {
  it('re-exports provider event helper and provider classes', () => {
    expect(typeof agents.createProviderEvent).toBe('function');
    expect(typeof agents.ClaudeProvider).toBe('function');
    expect(typeof agents.CodexProvider).toBe('function');
  });
});
