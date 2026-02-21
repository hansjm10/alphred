import { describe, expect, it } from 'vitest';
import {
  RUN_ROUTE_FIXTURES,
  buildRunWorktreeHref,
  findRunByParam,
  normalizeRunFilter,
  normalizeRunRepositoryParam,
  resolveWorktreePath,
} from './run-route-fixtures';

describe('run-route-fixtures helpers', () => {
  it('normalizes repeated status query values using the first value', () => {
    expect(normalizeRunFilter(['failed', 'running'])).toBe('failed');
    expect(normalizeRunFilter(['paused', 'running'])).toBe('all');
    expect(normalizeRunFilter(undefined)).toBe('all');
  });

  it('normalizes repository query values with first-value and trim semantics', () => {
    expect(normalizeRunRepositoryParam(['demo-repo', 'sample-repo'])).toBe('demo-repo');
    expect(normalizeRunRepositoryParam('  demo-repo  ')).toBe('demo-repo');
    expect(normalizeRunRepositoryParam('   ')).toBeNull();
    expect(normalizeRunRepositoryParam(undefined)).toBeNull();
  });

  it('returns null for invalid run id params', () => {
    expect(findRunByParam('0')).toBeNull();
    expect(findRunByParam('-1')).toBeNull();
    expect(findRunByParam('412.5')).toBeNull();
    expect(findRunByParam('not-a-number')).toBeNull();
  });

  it('returns matching runs for valid run id params', () => {
    expect(findRunByParam('412')?.id).toBe(412);
  });

  it('encodes worktree file paths in generated hrefs', () => {
    expect(buildRunWorktreeHref(412, 'src/core/engine.ts')).toBe(
      '/runs/412/worktree?path=src%2Fcore%2Fengine.ts',
    );
  });

  it('resolves worktree path using first query value and fallback behavior', () => {
    const run = RUN_ROUTE_FIXTURES.find((candidate) => candidate.id === 412);
    expect(run).toBeDefined();

    if (!run) {
      return;
    }

    expect(resolveWorktreePath(run, undefined)).toBe('src/core/engine.ts');
    expect(resolveWorktreePath(run, ['apps/dashboard/app/runs/page.tsx', 'src/core/engine.ts'])).toBe(
      'apps/dashboard/app/runs/page.tsx',
    );
    expect(resolveWorktreePath(run, ['does/not/exist.ts', 'apps/dashboard/app/runs/page.tsx'])).toBe(
      'src/core/engine.ts',
    );
  });

  it('defaults to the first changed file when the first tracked file is unchanged', () => {
    const run = {
      ...RUN_ROUTE_FIXTURES[0],
      worktree: {
        branch: 'alphred/demo-tree/custom',
        files: [
          {
            path: 'README.md',
            changed: false,
            preview: 'Readme only.',
            diff: '',
          },
          {
            path: 'src/core/engine.ts',
            changed: true,
            preview: 'Engine changes.',
            diff: '+ new engine change',
          },
        ],
      },
    };

    expect(resolveWorktreePath(run, undefined)).toBe('src/core/engine.ts');
    expect(resolveWorktreePath(run, 'does/not/exist.ts')).toBe('src/core/engine.ts');
  });

  it('falls back to the first tracked file when a run has no changed files', () => {
    const run = RUN_ROUTE_FIXTURES.find((candidate) => candidate.id === 410);
    expect(run).toBeDefined();

    if (!run) {
      return;
    }

    expect(resolveWorktreePath(run, undefined)).toBe('reports/final-summary.md');
    expect(resolveWorktreePath(run, 'does/not/exist.md')).toBe('reports/final-summary.md');
  });
});
