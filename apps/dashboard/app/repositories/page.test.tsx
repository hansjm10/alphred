// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RepositoriesPage, { RepositoriesPageContent } from './page';
import type { GitHubAuthGate } from '../ui/github-auth';
import { createGitHubAuthGate } from '../ui/github-auth';

const { loadGitHubAuthGateMock } = vi.hoisted(() => ({
  loadGitHubAuthGateMock: vi.fn(),
}));

vi.mock('../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

describe('RepositoriesPage', () => {
  beforeEach(() => {
    loadGitHubAuthGateMock.mockReset();
  });

  it('renders shared repository status badges and actions', () => {
    render(
      <RepositoriesPageContent
        repositories={[
          { name: 'demo-repo', status: 'completed', label: 'Cloned' },
          { name: 'sample-repo', status: 'failed', label: 'Sync error' },
          { name: 'new-repo', status: 'pending', label: 'Not synced' },
        ]}
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Repository registry' })).toBeInTheDocument();
    expect(screen.getByText('demo-repo')).toBeInTheDocument();
    expect(screen.getByText('Cloned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeInTheDocument();
  });

  it('renders empty-state callout when no repositories exist', () => {
    render(
      <RepositoriesPageContent
        repositories={[]}
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No repositories configured' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Repository' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeDisabled();
  });

  it('disables repository sync and shows remediation when unauthenticated', () => {
    render(
      <RepositoriesPageContent
        repositories={[
          { name: 'demo-repo', status: 'completed', label: 'Cloned' },
        ]}
        authGate={createGitHubAuthGate({
          authenticated: false,
          user: null,
          scopes: [],
          error: 'Run gh auth login before syncing repositories.',
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeDisabled();
    expect(screen.getByText('gh auth login')).toBeInTheDocument();
  });

  it('loads auth gate for the async repositories export when no authGate prop is provided', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await RepositoriesPage({
      repositories: [],
    })) as ReactElement<{
      repositories: readonly unknown[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(RepositoriesPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });

  it('uses provided authGate without calling loader in async repositories export', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });

    const root = (await RepositoriesPage({
      repositories: [],
      authGate,
    })) as ReactElement<{
      repositories: readonly unknown[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(RepositoriesPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });
});
