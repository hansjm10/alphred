import { describe, expect, it } from 'vitest';
import { AzureDevOpsScmProvider } from './azureDevopsScmProvider.js';
import { GitHubScmProvider } from './githubScmProvider.js';
import { createScmProvider } from './scmProvider.js';

describe('createScmProvider', () => {
  it('creates a github scm provider from github config', () => {
    const provider = createScmProvider({
      kind: 'github',
      repo: 'owner/repo',
    });

    expect(provider).toBeInstanceOf(GitHubScmProvider);
    expect(provider.kind).toBe('github');
  });

  it('creates an azure devops scm provider from azure config', () => {
    const provider = createScmProvider({
      kind: 'azure-devops',
      organization: 'org',
      project: 'proj',
      repository: 'repo',
    });

    expect(provider).toBeInstanceOf(AzureDevOpsScmProvider);
    expect(provider.kind).toBe('azure-devops');
  });

  it('throws a deterministic error for unknown provider kinds', () => {
    const unsupportedConfig = { kind: 'gitlab' } as unknown as Parameters<typeof createScmProvider>[0];
    expect(() => createScmProvider(unsupportedConfig)).toThrow('Unsupported SCM provider kind: gitlab');
  });
});
