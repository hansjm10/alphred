// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IntegrationsPage, { IntegrationsPageContent } from './page';
import type { GitHubAuthGate } from '../../ui/github-auth';
import { createGitHubAuthErrorGate, createGitHubAuthGate } from '../../ui/github-auth';

const { refreshMock, loadGitHubAuthGateMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  loadGitHubAuthGateMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshMock,
  }),
}));

vi.mock('../../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

describe('IntegrationsPage', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    refreshMock.mockReset();
    loadGitHubAuthGateMock.mockReset();
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

  it('surfaces an inline status message when auth check returns a non-ok status', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));

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

  it('loads auth gate for the async integrations export when no authGate prop is provided', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await IntegrationsPage()) as ReactElement<{ authGate: GitHubAuthGate }>;

    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(IntegrationsPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });

  it('uses provided authGate without calling loader in async integrations export', async () => {
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });

    const root = (await IntegrationsPage({ authGate })) as ReactElement<{ authGate: GitHubAuthGate }>;

    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(IntegrationsPageContent);
    expect(root.props.authGate).toEqual(authGate);
  });
});
