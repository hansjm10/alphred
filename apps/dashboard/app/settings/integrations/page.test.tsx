// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationsPageContent } from './page';
import { createGitHubAuthErrorGate, createGitHubAuthGate } from '../../ui/github-auth';

describe('IntegrationsPage', () => {
  it('renders auth status and remediation actions', () => {
    render(
      <IntegrationsPageContent
        authGate={createGitHubAuthGate({
          authenticated: true,
          user: 'octocat',
          scopes: ['repo'],
          error: null,
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Integrations status' })).toBeInTheDocument();
    expect(screen.getByText('Authenticated')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check Auth' })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
    expect(screen.getByText('octocat')).toBeInTheDocument();
  });

  it('shows remediation commands for auth check failures', () => {
    render(
      <IntegrationsPageContent
        authGate={createGitHubAuthErrorGate('Unable to verify auth from runtime')}
      />,
    );

    expect(screen.getByText('Auth check failed')).toBeInTheDocument();
    expect(screen.getByText('gh auth login')).toBeInTheDocument();
    expect(screen.getByText('export ALPHRED_GH_TOKEN="<github_token>"')).toBeInTheDocument();
  });
});
