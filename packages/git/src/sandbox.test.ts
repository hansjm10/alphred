import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveSandboxRepoPath, resolveSandboxDir } from './sandbox.js';

describe('sandbox helpers', () => {
  it('uses ~/.alphred/repos as the default sandbox directory', () => {
    expect(resolveSandboxDir({})).toBe(join(homedir(), '.alphred', 'repos'));
  });

  it('uses ALPHRED_SANDBOX_DIR when provided', () => {
    expect(resolveSandboxDir({ ALPHRED_SANDBOX_DIR: '/tmp/alphred-sandbox' })).toBe('/tmp/alphred-sandbox');
  });

  it('derives a deterministic GitHub path from owner/repo refs', () => {
    expect(
      deriveSandboxRepoPath('github', 'acme/frontend', {
        ALPHRED_SANDBOX_DIR: '/tmp/sandbox',
      }),
    ).toBe('/tmp/sandbox/github/acme/frontend');
  });

  it('includes host segment for GitHub enterprise refs', () => {
    expect(
      deriveSandboxRepoPath('github', 'github.example.com/acme/frontend', {
        ALPHRED_SANDBOX_DIR: '/tmp/sandbox',
      }),
    ).toBe('/tmp/sandbox/github/github.example.com/acme/frontend');
  });

  it('derives a deterministic Azure DevOps path from org/project/repo refs', () => {
    expect(
      deriveSandboxRepoPath('azure-devops', 'acme/platform/frontend', {
        ALPHRED_SANDBOX_DIR: '/tmp/sandbox',
      }),
    ).toBe('/tmp/sandbox/azure-devops/acme/platform/frontend');
  });

  it('rejects malformed remote refs', () => {
    expect(() => deriveSandboxRepoPath('github', 'owner-only', { ALPHRED_SANDBOX_DIR: '/tmp/sandbox' })).toThrow(
      'Invalid GitHub remoteRef',
    );

    expect(() =>
      deriveSandboxRepoPath('azure-devops', 'org/project', { ALPHRED_SANDBOX_DIR: '/tmp/sandbox' }),
    ).toThrow('Invalid Azure DevOps remoteRef');
  });

  it('rejects path traversal segments', () => {
    expect(() => deriveSandboxRepoPath('github', 'owner/..', { ALPHRED_SANDBOX_DIR: '/tmp/sandbox' })).toThrow(
      'Invalid sandbox path segment',
    );
  });
});
