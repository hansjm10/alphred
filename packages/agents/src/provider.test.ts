import { describe, it, expect } from 'vitest';
import { createProviderEvent } from './provider.js';

describe('AgentProvider', () => {
  it('should create a provider event', () => {
    const event = createProviderEvent('assistant', 'Hello, world!');
    expect(event.type).toBe('assistant');
    expect(event.content).toBe('Hello, world!');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('should include metadata when provided', () => {
    const event = createProviderEvent('usage', '', { tokens: 100 });
    expect(event.metadata).toEqual({ tokens: 100 });
  });
});
