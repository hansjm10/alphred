import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BRANCH_TEMPLATE,
  generateBranchName,
  generateConfiguredBranchName,
  resolveBranchTemplate,
  type BranchNameContext,
} from './branchName.js';

const baseContext: BranchNameContext = {
  treeKey: 'design_tree',
  runId: 42,
  nodeKey: 'implement',
  issueId: '123',
  timestamp: 1_708_000_000,
};

describe('branch template helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the default template when no explicit or env template is set', () => {
    expect(resolveBranchTemplate()).toBe(DEFAULT_BRANCH_TEMPLATE);
  });

  it('uses ALPHRED_BRANCH_TEMPLATE when no explicit template is provided', () => {
    vi.stubEnv('ALPHRED_BRANCH_TEMPLATE', 'custom/{tree-key}/{run-id}');

    expect(resolveBranchTemplate()).toBe('custom/{tree-key}/{run-id}');
  });

  it('prioritizes explicit template over ALPHRED_BRANCH_TEMPLATE', () => {
    vi.stubEnv('ALPHRED_BRANCH_TEMPLATE', 'env/{tree-key}/{run-id}');

    expect(resolveBranchTemplate('explicit/{tree-key}')).toBe('explicit/{tree-key}');
  });

  it('expands all documented tokens', () => {
    const branch = generateBranchName(
      'alphred/{tree-key}/{run-id}/{node-key}/{issue-id}/{timestamp}/{short-hash}/{date}',
      baseContext,
      { randomHex: () => 'a1b2c3' },
    );

    expect(branch).toBe('alphred/design-tree/42/implement/123/1708000000/a1b2c3/2024-02-15');
  });

  it('treats missing optional issue-id token as empty and normalizes separators', () => {
    const branch = generateBranchName('alphred/{issue-id}-{tree-key}/{run-id}', {
      treeKey: 'design_tree',
      runId: 42,
    });

    expect(branch).toBe('alphred/design-tree/42');
  });

  it('sanitizes git-disallowed characters and invalid suffixes', () => {
    const branch = generateBranchName('alphred/ bad name /te..st~^:\\\\\\control.lock.', {
      treeKey: 'ignored',
      runId: 1,
    });

    expect(branch).toBe('alphred/bad-name/te.st-control');
    expect(branch).not.toContain(' ');
    expect(branch).not.toContain('..');
    expect(branch).not.toContain('~');
    expect(branch).not.toContain('^');
    expect(branch).not.toContain(':');
    expect(branch).not.toContain('\\');
  });

  it('falls back from explicit template to env then default when generating configured names', () => {
    const context: BranchNameContext = { treeKey: 'tree_a', runId: 7 };

    vi.stubEnv('ALPHRED_BRANCH_TEMPLATE', 'env/{tree-key}/{run-id}');
    expect(generateConfiguredBranchName(context)).toBe('env/tree-a/7');
    expect(generateConfiguredBranchName(context, 'explicit/{tree-key}')).toBe('explicit/tree-a');

    vi.unstubAllEnvs();
    expect(generateConfiguredBranchName(context)).toBe('alphred/tree-a/7');
  });
});
