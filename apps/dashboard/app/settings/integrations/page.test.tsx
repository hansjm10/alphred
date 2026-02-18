// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsPageContent } from './page';
import { createGitHubAuthErrorGate, createGitHubAuthGate } from '../../ui/github-auth';

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

describe('IntegrationsPage', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    refreshMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    expect(screen.getByRole('button', { name: 'Check Auth' })).toBeInTheDocument();
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

  it('shows checking state and refreshes the route when auth check succeeds', async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValue(pendingFetch);

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

    await user.click(screen.getByRole('button', { name: 'Check Auth' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/auth/github/check', {
      method: 'POST',
      cache: 'no-store',
    });
    expect(screen.getByRole('button', { name: 'Checking auth...' })).toBeDisabled();
    expect(screen.getByText('Checking')).toBeInTheDocument();

    resolveFetch(new Response('{}', { status: 200 }));

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces an inline status message when auth check fails', async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new Error('network down'));

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

    await user.click(screen.getByRole('button', { name: 'Check Auth' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Unable to refresh GitHub authentication status. Try again.',
      );
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
