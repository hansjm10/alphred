// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepositoriesPage, { RepositoriesPageContent } from './page';
import type { DashboardRepositoryState, DashboardRepositorySyncResult } from '@dashboard/server/dashboard-contracts';
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
    archivedAt: overrides.archivedAt ?? null,
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

function createJsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), init);
}

function createRepositorySyncResult(
  action: DashboardRepositorySyncResult['action'],
  repository: DashboardRepositoryState,
): DashboardRepositorySyncResult {
  return {
    action,
    repository,
    sync: {
      mode: 'pull',
      strategy: 'ff-only',
      branch: repository.defaultBranch,
      status: action === 'cloned' ? 'updated' : 'up_to_date',
      conflictMessage: null,
    },
  };
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
    expect(screen.getByRole('link', { name: 'Open Board' })).toHaveAttribute(
      'href',
      '/repositories/1/board',
    );
  });

  it('renders empty-state callout when no repositories exist', () => {
    render(
      <RepositoriesPageContent
        repositories={[]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No repositories configured' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add Repository' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Add repository' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add and Sync' })).toBeEnabled();
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
    expect(
      screen.getByText('Dashboard add is blocked until GitHub authentication is restored. Use CLI commands below or re-authenticate.'),
    ).toBeInTheDocument();
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
      createJsonResponse(
        createRepositorySyncResult(
          'cloned',
          createRepository({
            id: 3,
            name: 'new-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/new-repo',
          }),
        ),
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
    expect(screen.getByText('new-repo sync completed (cloned, updated).')).toBeInTheDocument();
  });

  it('archives an active repository and refreshes the default active-only list', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'demo-repo',
        cloneStatus: 'cloned',
      }),
    ];
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({
            id: 1,
            name: 'demo-repo',
            archivedAt: '2026-03-03T10:20:30.000Z',
          }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [],
        }),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Archive demo-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories/demo-repo/actions/archive', {
        method: 'POST',
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories', {
        method: 'GET',
      });
    });

    expect(screen.getByText('demo-repo archived.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync demo-repo' })).toBeNull();
  });

  it('keeps archive success state when list refresh fails', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'demo-repo',
        cloneStatus: 'cloned',
      }),
    ];
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({
            id: 1,
            name: 'demo-repo',
            archivedAt: '2026-03-03T10:20:30.000Z',
          }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: {
              message: 'Repository list refresh failed (temporary outage).',
            },
          },
          { status: 503 },
        ),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Archive demo-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories/demo-repo/actions/archive', {
        method: 'POST',
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories', {
        method: 'GET',
      });
    });

    expect(screen.getByText('demo-repo archived, but Repository list refresh failed (temporary outage).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync demo-repo' })).toBeNull();
  });

  it('refreshes archived data using the latest filter when archive completes after a toggle', async () => {
    const active = createRepository({
      id: 1,
      name: 'demo-repo',
      cloneStatus: 'cloned',
    });
    const archived = createRepository({
      ...active,
      archivedAt: '2026-03-03T10:20:30.000Z',
    });

    let resolveArchiveRequest!: (value: Response) => void;
    const archiveRequest = new Promise<Response>((resolve) => {
      resolveArchiveRequest = resolve;
    });

    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockReturnValueOnce(archiveRequest)
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [archived],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [archived],
        }),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={[active]} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Archive demo-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories/demo-repo/actions/archive', {
        method: 'POST',
      });
    });

    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
      expect(screen.getByRole('checkbox', { name: 'Show archived' })).toBeChecked();
    });

    resolveArchiveRequest(
      createJsonResponse({
        repository: archived,
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
    });
  });

  it('shows archived repositories on demand and restores from row actions', async () => {
    const active = createRepository({
      id: 1,
      name: 'active-repo',
      cloneStatus: 'cloned',
    });
    const archived = createRepository({
      id: 2,
      name: 'archived-repo',
      cloneStatus: 'cloned',
      archivedAt: '2026-03-03T10:20:30.000Z',
    });
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [active, archived],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: createRepository({
            ...archived,
            archivedAt: null,
          }),
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [
            active,
            createRepository({
              ...archived,
              archivedAt: null,
            }),
          ],
        }),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={[active]} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
    });
    expect(await screen.findByRole('button', { name: 'Restore archived-repo' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore archived-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories/archived-repo/actions/restore', {
        method: 'POST',
      });
      expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
    });

    expect(screen.getByText('archived-repo restored.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive archived-repo' })).toBeInTheDocument();
  });

  it('keeps restore success state when list refresh fails', async () => {
    const active = createRepository({
      id: 1,
      name: 'active-repo',
      cloneStatus: 'cloned',
    });
    const archived = createRepository({
      id: 2,
      name: 'archived-repo',
      cloneStatus: 'cloned',
      archivedAt: '2026-03-03T10:20:30.000Z',
    });
    const restored = createRepository({
      ...archived,
      archivedAt: null,
    });

    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          repositories: [active, archived],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          repository: restored,
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: {
              message: 'Repository list refresh failed (temporary outage).',
            },
          },
          { status: 503 },
        ),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={[active]} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
    });
    expect(await screen.findByRole('button', { name: 'Restore archived-repo' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore archived-repo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories/archived-repo/actions/restore', {
        method: 'POST',
      });
      expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/dashboard/repositories?includeArchived=1', {
        method: 'GET',
      });
    });

    expect(screen.getByText('archived-repo restored, but Repository list refresh failed (temporary outage).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive archived-repo' })).toBeInTheDocument();
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
      createJsonResponse(
        createRepositorySyncResult(
          'cloned',
          createRepository({
            id: 1,
            name: 'alpha-repo',
            cloneStatus: 'cloned',
            localPath: '/tmp/repos/alpha-repo',
          }),
        ),
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
        createJsonResponse(
          {
            error: {
              message: 'GitHub authentication is required.',
            },
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          createRepositorySyncResult(
            'fetched',
            createRepository({
              id: 2,
              name: 'sample-repo',
              cloneStatus: 'cloned',
              localPath: '/tmp/repos/sample-repo',
            }),
          ),
        ),
      );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={repositories} authGate={createAuthenticatedAuthGate()} />);

    await user.click(screen.getByRole('button', { name: 'Retry sample-repo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub authentication is required.');
    expect(screen.getByRole('button', { name: 'Retry sample-repo' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry sample-repo' }));
    expect(await screen.findAllByText('/tmp/repos/sample-repo')).toHaveLength(2);
    expect(screen.getByText('sample-repo sync completed (fetched, up_to_date).')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adds a repository and auto-syncs it', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock
      .mockResolvedValueOnce(createJsonResponse({
        repository: createRepository({
          id: 22,
          name: 'new-repo',
          cloneStatus: 'pending',
          localPath: null,
        }),
      }, { status: 201 }))
      .mockResolvedValueOnce(
        createJsonResponse(
          createRepositorySyncResult(
            'cloned',
            createRepository({
              id: 22,
              name: 'new-repo',
              cloneStatus: 'cloned',
              localPath: '/tmp/repos/new-repo',
            }),
          ),
        ),
      );

    const user = userEvent.setup();
    render(
      <RepositoriesPageContent
        repositories={[createRepository({ id: 1, name: 'demo-repo' })]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add Repository' }));
    await user.type(screen.getByLabelText('Repository name'), 'new-repo');
    await user.type(screen.getByLabelText('GitHub repository'), 'octocat/new-repo');
    await user.click(screen.getByRole('button', { name: 'Add and Sync' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dashboard/repositories', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'new-repo',
          provider: 'github',
          remoteRef: 'octocat/new-repo',
        }),
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/dashboard/repositories/new-repo/sync', {
        method: 'POST',
      });
    });

    expect(await screen.findAllByText('/tmp/repos/new-repo')).toHaveLength(2);
    expect(screen.getByText('new-repo sync completed (cloned, updated).')).toBeInTheDocument();
  });

  it('keeps add form visible and surfaces errors when add repository fails', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse(
        {
          error: {
            message: 'Repository "new-repo" already exists.',
          },
        },
        { status: 409 },
      ),
    );

    const user = userEvent.setup();
    render(<RepositoriesPageContent repositories={[]} authGate={createAuthenticatedAuthGate()} />);

    await user.type(screen.getByLabelText('Repository name'), 'new-repo');
    await user.type(screen.getByLabelText('GitHub repository'), 'octocat/new-repo');
    await user.click(screen.getByRole('button', { name: 'Add and Sync' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Repository "new-repo" already exists.');
    expect(screen.getAllByText('Repository "new-repo" already exists.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add and Sync' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters repositories by name/provider/remoteRef and restores list when cleared', async () => {
    const user = userEvent.setup();
    render(
      <RepositoriesPageContent
        repositories={[
          createRepository({ id: 1, name: 'frontend', provider: 'github', remoteRef: 'octocat/frontend' }),
          createRepository({ id: 2, name: 'legacy', provider: 'azure-devops', remoteRef: 'org/proj/legacy' }),
          createRepository({ id: 3, name: 'service', provider: 'github', remoteRef: 'octocat/services-api' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    const searchInput = screen.getByRole('textbox', { name: 'Search repositories' });

    await user.type(searchInput, 'azure');
    expect(screen.getByRole('button', { name: 'legacy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frontend' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'service' })).toBeNull();

    await user.clear(searchInput);
    expect(screen.getByRole('button', { name: 'legacy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frontend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'service' })).toBeInTheDocument();
  });

  it('clears selected repository actions when the filter has no visible rows', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(global.fetch);
    render(
      <RepositoriesPageContent
        repositories={[
          createRepository({ id: 1, name: 'alphred' }),
          createRepository({ id: 2, name: 'service' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Search repositories' }), 'zzzz-no-match');

    expect(screen.getByText('No repositories match this filter.')).toBeInTheDocument();
    expect(screen.getByText('Select a repository to inspect details.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync Selected' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Sync Selected' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('targets a visible filtered repository when syncing from side-panel action', async () => {
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse(
        createRepositorySyncResult(
          'fetched',
          createRepository({
            id: 2,
            name: 'beta-repo',
            cloneStatus: 'cloned',
          }),
        ),
      ),
    );

    const user = userEvent.setup();
    render(
      <RepositoriesPageContent
        repositories={[
          createRepository({ id: 1, name: 'alphred' }),
          createRepository({ id: 2, name: 'beta-repo' }),
        ]}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Search repositories' }), 'beta');
    await user.click(screen.getByRole('button', { name: 'Sync Selected' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/repositories/beta-repo/sync', {
        method: 'POST',
      });
    });
  });

  it('gates launch action by selected repository clone status and auth mutability', async () => {
    const repositories = [
      createRepository({
        id: 1,
        name: 'pending-repo',
        cloneStatus: 'pending',
        localPath: null,
      }),
      createRepository({
        id: 2,
        name: 'cloned-repo',
        cloneStatus: 'cloned',
        localPath: '/tmp/repos/cloned-repo',
      }),
    ];
    const user = userEvent.setup();
    const { rerender } = render(
      <RepositoriesPageContent
        repositories={repositories}
        authGate={createAuthenticatedAuthGate()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Launch Run with this repo' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'cloned-repo' }));
    expect(screen.getByRole('link', { name: 'Launch Run with this repo' })).toHaveAttribute(
      'href',
      '/runs?repository=cloned-repo',
    );

    rerender(
      <RepositoriesPageContent
        repositories={[repositories[1] as DashboardRepositoryState]}
        authGate={createGitHubAuthGate({
          authenticated: false,
          user: null,
          scopes: [],
          error: 'Run gh auth login.',
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Launch Run with this repo' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Launch Run with this repo' })).toBeNull();
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
