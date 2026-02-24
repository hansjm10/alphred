import { describe, expect, it } from 'vitest';
import {
  buildRunDetailHref,
  buildRunWorktreeHref,
  normalizeRunFilter,
  resolveRunFilterHref,
} from './run-route-utils';

describe('run-route-utils', () => {
  it('normalizes repeated status query values using the first value', () => {
    expect(normalizeRunFilter(['failed', 'running'])).toBe('failed');
    expect(normalizeRunFilter(['paused', 'running'])).toBe('all');
    expect(normalizeRunFilter(undefined)).toBe('all');
  });

  it('resolves run filter hrefs', () => {
    expect(resolveRunFilterHref('all')).toBe('/runs');
    expect(resolveRunFilterHref('running')).toBe('/runs?status=running');
    expect(resolveRunFilterHref('failed')).toBe('/runs?status=failed');
  });

  it('builds run detail hrefs', () => {
    expect(buildRunDetailHref(412)).toBe('/runs/412');
  });

  it('encodes worktree file paths in generated hrefs', () => {
    expect(buildRunWorktreeHref(412, 'src/core/engine.ts')).toBe(
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });
});
