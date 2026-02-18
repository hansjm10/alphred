// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RepositoriesPageContent } from './page';
import { createGitHubAuthGate } from '../ui/github-auth';

describe('RepositoriesPage', () => {
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
});
