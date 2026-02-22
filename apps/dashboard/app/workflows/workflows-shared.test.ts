import { describe, expect, it } from 'vitest';
import { resolveApiError, slugifyKey } from './workflows-shared';

describe('workflows-shared', () => {
  it('slugifies keys and trims hyphens', () => {
    expect(slugifyKey('  Demo Tree  ', 64)).toBe('demo-tree');
    expect(slugifyKey('---Demo---', 64)).toBe('demo');
    expect(slugifyKey('   ', 64)).toBe('');
  });

  it('resolves API error envelopes and falls back to status text', () => {
    expect(resolveApiError(403, { error: { message: 'No permissions.' } }, 'Duplicate failed')).toBe('No permissions.');
    expect(resolveApiError(500, null, 'Duplicate failed')).toBe('Duplicate failed (HTTP 500).');
  });
});

