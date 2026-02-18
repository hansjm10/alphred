// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepositoriesPage, { RepositoriesPageContent } from './page';
import type { DashboardRepositoryState } from '../../src/server/dashboard-contracts';
import type { GitHubAuthGate } from '../ui/github-auth';
import { createGitHubAuthGate } from '../ui/github-auth';

const { loadGitHubAuthGateMock, loadDashboardRepositoriesMock } = vi.hoisted(() => ({
  loadGitHubAuthGateMock: vi.fn(),
  loadDashboardRepositoriesMock: vi.fn(),
}));

vi.mock('../ui/load-github-auth-gate', () => ({
  loadGitHubAuthGate: loadGitHubAuthGateMock,
}));

vi.mock('./load-dashboard-repositories', () => ({
  loadDashboardRepositories: loadDashboardRepositoriesMock,
}));

function createRepository(overrides: Partial<DashboardRepositoryState> = {}): DashboardRepositoryState {
  const name = overrides.name ?? 'demo-repo';
  return {
    id: overrides.id ?? 1,
    name,
    provider: overrides.provider ?? 'github',
    remoteRef: overrides.remoteRef ?? `octocat/${name}`,
    remoteUrl: overrides.remoteUrl ?? `https://github.com/octocat/${name}.git`,
    defaultBranch: overrides.defaultBranch ?? 'main',
    branchTemplate: overrides.branchTemplate ?? null,
    cloneStatus: overrides.cloneStatus ?? 'cloned',
    localPath: overrides.localPath === undefined ? `/tmp/repos/${name}` : overrides.localPath,
  };
}

function createAuthenticatedAuthGate(): GitHubAuthGate {
  return createGitHubAuthGate({
    authenticated: true,
    user: 'octocat',
    scopes: ['repo'],
    error: null,
  });
}

describe('RepositoriesPage', () => {
  beforeEach(() => {
    loadGitHubAuthGateMock.mockReset();
    loadDashboardRepositoriesMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders repository lifecycle details with sync/retry actions', () => {
    render(
      <RepositoriesPageContent
        repositories={[
          createRepository({
            id: 1,
            name: 'demo-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/demo-repo',
          }),
          createRepository({
            id: 2,
            name: 'sample-repo',
            cloneStatus: 'error',
            localPath: null,
          }),
          createRepository({
            id: 3,
            name: 'new-repo',
            cloneStatus: 'pending',
            localPath: null,
          }),
        ]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Repository registry' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Clone status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry sample-repo' })).toBeInTheDocument();
    expect(screen.getByText('Cloned')).toBeInTheDocument();
    expect(screen.getAllByText('/tmp/repos/demo-repo')).toHaveLength(2);
  });

  it('renders empty-state callout when no repositories exist', () => {
    render(
      <RepositoriesPageContent
        repositories={[]}
        authGate={createAuthenticatedAuthGate()}
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
          createRepository({
            id: 1,
            name: 'demo-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/demo-repo',
          }),
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
    expect(screen.getByRole('button', { name: 'Sync demo-repo' })).toBeDisabled();
    expect(screen.getByText('gh auth login')).toBeInTheDocument();
  });

  it('syncs a pending repository and updates lifecycle to cloned', async () => {
    const repositories = [
      createRepository({
        id: 3,
        name: 'new-repo',
        cloneStatus: 'pending',
        localPath: null,
      }),
    ];
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          action: 'cloned',
          repository: createRepository({
            id: 3,
            name: 'new-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/new-repo',
          }),
        }),
      ),
    );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Sync new-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/new-repo/sync', {
        method: 'POST',
      });
    });

    expect(await screen.findAllByText('/tmp/repos/new-repo')).toHaveLength(2);
    expect(screen.getByText('new-repo sync completed (cloned).')).toBeInTheDocument();
  });

  it('disables all row sync actions while a sync is in progress', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'alpha-repo',
        cloneStatus: 'pending',
        localPath: null,
      }),
      createRepository({
        id: 2,
        name: 'beta-repo',
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/beta-repo',
      }),
    ];

    let resolveSync!: (value: Response) => void;
    const syncRequest = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockReturnValueOnce(syncRequest);

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Sync alpha-repo' }));

    expect(screen.getByRole('button', { name: 'Sync alpha-repo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync beta-repo' })).toBeDisabled();

    resolveSync(
      new Response(
        JSON.stringify({
          action: 'cloned',
          repository: createRepository({
            id: 1,
            name: 'alpha-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/alpha-repo',
          }),
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sync beta-repo' })).toBeEnabled();
    });
  });

  it('keeps retry path visible after sync failure and recovers on retry', async () => {
    const repositories = [
      createRepository({
        id: 2,
        name: 'sample-repo',
        cloneStatus: 'error',
        localPath: null,
      }),
    ];
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'GitHub authentication is required.',
            },
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            action: 'fetched',
            repository: createRepository({
              id: 2,
              name: 'sample-repo',
              cloneStatus: 'cloned',
              localPath: '/tmp/repos/sample-repo',
            }),
          }),
        ),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Retry sample-repo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub authentication is required.');
    expect(screen.getByRole('button', { name: 'Retry sample-repo' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry sample-repo' }));
    expect(await screen.findAllByText('/tmp/repos/sample-repo')).toHaveLength(2);
    expect(screen.getByText('sample-repo sync completed (fetched).')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads repositories and auth gate for the async repositories export when props are omitted', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'demo-repo',
      }),
    ];
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });
    loadDashboardRepositoriesMock.mockResolvedValue(repositories);
    loadGitHubAuthGateMock.mockResolvedValue(authGate);

    const root = (await RepositoriesPage()) as ReactElement<{
      repositories: readonly DashboardRepositoryState[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadDashboardRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(loadGitHubAuthGateMock).toHaveBeenCalledTimes(1);
    expect(root.type).toBe(RepositoriesPageContent);
    expect(root.props.repositories).toEqual(repositories);
    expect(root.props.authGate).toEqual(authGate);
  });

  it('uses provided repositories and authGate without invoking loaders', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'demo-repo',
      }),
    ];
    const authGate = createGitHubAuthGate({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    });

    const root = (await RepositoriesPage({
      repositories,
      authGate,
    })) as ReactElement<{
      repositories: readonly DashboardRepositoryState[];
      authGate: GitHubAuthGate;
    }>;

    expect(loadDashboardRepositoriesMock).not.toHaveBeenCalled();
    expect(loadGitHubAuthGateMock).not.toHaveBeenCalled();
    expect(root.type).toBe(RepositoriesPageContent);
    expect(root.props.repositories).toEqual(repositories);
    expect(root.props.authGate).toEqual(authGate);
  });
});
