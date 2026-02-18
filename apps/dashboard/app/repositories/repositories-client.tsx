'use client';

import { useMemo, useState } from 'react';
import type {
  DashboardCreateRepositoryResult,
  DashboardRepositoryState,
  DashboardRepositorySyncResult,
} from '../../src/server/dashboard-contracts';
import { AuthRemediation } from '../ui/auth-remediation';
import type { GitHubAuthGate } from '../ui/github-auth';
import {
  ActionButton,
  ButtonLink,
  Card,
  Panel,
  StatusBadge,
  type StatusVariant,
} from '../ui/primitives';

type SyncBanner = Readonly<{
  tone: 'success' | 'error';
  message: string;
}>;

type RepositoriesPageContentProps = Readonly<{
  repositories: readonly DashboardRepositoryState[];
  authGate: GitHubAuthGate;
}>;

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const REPO_REGISTRATION_COMMANDS = [
  'alphred repo add --name <name> --github <owner/repository>',
  'alphred repo list',
  'alphred repo show <name>',
] as const;

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function mapCloneStatusToBadge(
  cloneStatus: DashboardRepositoryState['cloneStatus'] | 'syncing',
): Readonly<{ status: StatusVariant; label: string }> {
  switch (cloneStatus) {
    case 'cloned':
      return { status: 'completed', label: 'Cloned' };
    case 'error':
      return { status: 'failed', label: 'Error' };
    case 'syncing':
      return { status: 'running', label: 'Sync in progress' };
    default:
      return { status: 'pending', label: 'Pending' };
  }
}

function resolveApiErrorMessage(status: number, payload: unknown, fallbackPrefix: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as ErrorEnvelope).error === 'object' &&
    (payload as ErrorEnvelope).error !== null &&
    typeof (payload as ErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as ErrorEnvelope).error?.message as string;
  }

  return `${fallbackPrefix} (HTTP ${status}).`;
}

function filterRepository(
  repository: DashboardRepositoryState,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }

  return (
    repository.name.toLowerCase().includes(normalizedQuery) ||
    repository.provider.toLowerCase().includes(normalizedQuery) ||
    repository.remoteRef.toLowerCase().includes(normalizedQuery)
  );
}

export function RepositoriesPageContent({
  repositories,
  authGate,
}: RepositoriesPageContentProps) {
  const [repositoryState, setRepositoryState] = useState<readonly DashboardRepositoryState[]>(repositories);
  const [selectedRepositoryName, setSelectedRepositoryName] = useState<string | null>(repositoryState[0]?.name ?? null);
  const [syncingRepositoryName, setSyncingRepositoryName] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [lastSyncLabels, setLastSyncLabels] = useState<Record<string, string>>({});
  const [syncBanner, setSyncBanner] = useState<SyncBanner | null>(null);
  const [isAddFormOpen, setIsAddFormOpen] = useState<boolean>(repositoryState.length === 0);
  const [newRepositoryName, setNewRepositoryName] = useState('');
  const [newRepositoryRemoteRef, setNewRepositoryRemoteRef] = useState('');
  const [isAddingRepository, setIsAddingRepository] = useState(false);
  const [addRepositoryError, setAddRepositoryError] = useState<string | null>(null);

  const syncBlocked = !authGate.canMutate;
  const actionBlocked = syncBlocked || syncingRepositoryName !== null || isAddingRepository;
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredRepositories = useMemo(
    () => repositoryState.filter(repository => filterRepository(repository, normalizedQuery)),
    [normalizedQuery, repositoryState],
  );

  const selectedRepository =
    repositoryState.find(repository => repository.name === selectedRepositoryName) ?? repositoryState[0] ?? null;
  const selectedRepositorySyncError = selectedRepository ? syncErrors[selectedRepository.name] : undefined;
  const canLaunchWithSelectedRepository =
    selectedRepository !== null && selectedRepository.cloneStatus === 'cloned' && authGate.canMutate;
  const addFormHint = syncBlocked
    ? 'Dashboard add is blocked until GitHub authentication is restored. Use CLI commands below or re-authenticate.'
    : 'Add Repository registers a GitHub repository and starts sync automatically.';

  async function handleSync(repository: DashboardRepositoryState): Promise<void> {
    if (syncBlocked || syncingRepositoryName !== null || isAddingRepository) {
      return;
    }

    setSelectedRepositoryName(repository.name);
    setSyncBanner(null);
    setSyncingRepositoryName(repository.name);

    try {
      const response = await fetch(
        `/api/dashboard/repositories/${encodeURIComponent(repository.name)}/sync`,
        { method: 'POST' },
      );
      const payload = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Repository sync failed'));
      }

      const result = payload as DashboardRepositorySyncResult;
      setRepositoryState(current =>
        current.map(existing => (existing.name === repository.name ? result.repository : existing)),
      );
      setSyncErrors(current => {
        const next = { ...current };
        delete next[repository.name];
        return next;
      });
      setLastSyncLabels(current => ({
        ...current,
        [repository.name]: formatTimeLabel(new Date()),
      }));
      setSyncBanner({
        tone: 'success',
        message: `${result.repository.name} sync completed (${result.action}).`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repository sync failed.';
      setRepositoryState(current =>
        current.map(existing =>
          existing.name === repository.name
            ? {
              ...existing,
              cloneStatus: 'error',
            }
            : existing),
      );
      setSyncErrors(current => ({
        ...current,
        [repository.name]: message,
      }));
      setSyncBanner({
        tone: 'error',
        message,
      });
    } finally {
      setSyncingRepositoryName(null);
    }
  }

  function handleOpenAddForm(): void {
    setIsAddFormOpen(true);
    setAddRepositoryError(null);
  }

  async function handleAddRepository(): Promise<void> {
    if (actionBlocked) {
      return;
    }

    const name = newRepositoryName.trim();
    if (name.length === 0) {
      setAddRepositoryError('Repository name is required.');
      return;
    }

    const remoteRef = newRepositoryRemoteRef.trim();
    if (remoteRef.length === 0) {
      setAddRepositoryError('GitHub repository reference is required.');
      return;
    }

    setAddRepositoryError(null);
    setSyncBanner(null);
    setIsAddingRepository(true);

    try {
      const response = await fetch('/api/dashboard/repositories', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name,
          provider: 'github',
          remoteRef,
        }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Repository add failed'));
      }

      const result = payload as DashboardCreateRepositoryResult;
      setRepositoryState(current =>
        [...current.filter(existing => existing.name !== result.repository.name), result.repository]
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
      setSelectedRepositoryName(result.repository.name);
      setSyncErrors(current => {
        const next = { ...current };
        delete next[result.repository.name];
        return next;
      });
      setLastSyncLabels(current => {
        const next = { ...current };
        delete next[result.repository.name];
        return next;
      });
      setNewRepositoryName('');
      setNewRepositoryRemoteRef('');
      setSyncBanner({
        tone: 'success',
        message: `${result.repository.name} registered. Starting sync...`,
      });

      await handleSync(result.repository);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repository add failed.';
      setAddRepositoryError(message);
      setSyncBanner({
        tone: 'error',
        message,
      });
    } finally {
      setIsAddingRepository(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Repository registry</h2>
        <p>Track clone lifecycle state and keep launch targets ready.</p>
      </section>

      <div className="page-grid">
        <Card
          title="Repositories"
          description="Name, provider, clone state, local path, and sync actions."
        >
          {syncBanner ? (
            <p
              className={`repo-banner repo-banner--${syncBanner.tone}`}
              role={syncBanner.tone === 'error' ? 'alert' : 'status'}
            >
              {syncBanner.message}
            </p>
          ) : null}

          <div className="repositories-toolbar">
            <label className="repositories-search" htmlFor="repositories-search">
              <span className="meta-text">Search repositories</span>
              <input
                id="repositories-search"
                name="repositories-search"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.currentTarget.value);
                }}
                placeholder="Search name, provider, or remote ref"
              />
            </label>
          </div>

          {repositoryState.length === 0 ? (
            <div className="page-stack">
              <h3>No repositories configured</h3>
              <p>Add a GitHub repository to register it and trigger sync from the dashboard.</p>
              <div className="action-row">
                <ActionButton
                  tone="primary"
                  disabled={actionBlocked}
                  aria-disabled={actionBlocked}
                  onClick={() => {
                    handleOpenAddForm();
                  }}
                >
                  Add Repository
                </ActionButton>
              </div>
              <p className="meta-text repo-add-hint">{addFormHint}</p>
            </div>
          ) : filteredRepositories.length === 0 ? (
            <p>No repositories match this filter.</p>
          ) : (
            <div className="repositories-table-wrapper">
              <table className="repositories-table">
                <thead>
                  <tr>
                    <th scope="col">Repository</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Clone status</th>
                    <th scope="col">Local path</th>
                    <th scope="col">Last sync</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRepositories.map((repository) => {
                    const isSyncing = syncingRepositoryName === repository.name;
                    const cloneStatus = isSyncing ? 'syncing' : repository.cloneStatus;
                    const badge = mapCloneStatusToBadge(cloneStatus);
                    const syncErrorMessage =
                      syncErrors[repository.name] ??
                      (repository.cloneStatus === 'error' ? 'Latest sync failed. Retry to recover.' : null);
                    const actionLabel = repository.cloneStatus === 'error' ? 'Retry' : 'Sync';
                    const actionText = isSyncing ? 'Syncing...' : actionLabel;
                    const syncLabel = lastSyncLabels[repository.name] ?? (repository.cloneStatus === 'cloned'
                      ? 'Available'
                      : 'Not synced');
                    const selected = selectedRepository?.name === repository.name;

                    return (
                      <tr key={repository.id} className={selected ? 'repositories-row--selected' : undefined}>
                        <td>
                          <button
                            className="repo-name-button"
                            onClick={() => {
                              setSelectedRepositoryName(repository.name);
                            }}
                            type="button"
                          >
                            {repository.name}
                          </button>
                        </td>
                        <td>{repository.provider}</td>
                        <td>
                          <StatusBadge status={badge.status} label={badge.label} />
                        </td>
                        <td>
                          {repository.localPath ? (
                            <code className="repo-path">{repository.localPath}</code>
                          ) : syncErrorMessage ? (
                            <p className="repo-cell-error">{syncErrorMessage}</p>
                          ) : (
                            <span className="meta-text">Path unavailable</span>
                          )}
                        </td>
                        <td className="meta-text">{syncLabel}</td>
                        <td>
                          <ActionButton
                            aria-label={`${actionLabel} ${repository.name}`}
                            disabled={actionBlocked}
                            aria-disabled={actionBlocked}
                            onClick={() => {
                              void handleSync(repository);
                            }}
                          >
                            {actionText}
                          </ActionButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Panel title="Repository actions" description="Select a row to inspect details and run sync.">
          <p className="meta-text">{`GitHub auth: ${authGate.badge.label}`}</p>

          {selectedRepository ? (
            <ul className="entity-list repo-detail-list">
              <li>
                <span>Name</span>
                <span>{selectedRepository.name}</span>
              </li>
              <li>
                <span>Provider</span>
                <span>{selectedRepository.provider}</span>
              </li>
              <li>
                <span>Remote</span>
                <span>{selectedRepository.remoteRef}</span>
              </li>
              <li>
                <span>Local path</span>
                <span>{selectedRepository.localPath ?? 'Not available'}</span>
              </li>
            </ul>
          ) : (
            <p>Select a repository to inspect details.</p>
          )}

          {selectedRepository && selectedRepositorySyncError ? (
            <p className="repo-cell-error">{selectedRepositorySyncError}</p>
          ) : null}

          <div className="action-row">
            <ActionButton
              disabled={selectedRepository === null || actionBlocked}
              aria-disabled={selectedRepository === null || actionBlocked}
              onClick={() => {
                if (selectedRepository) {
                  void handleSync(selectedRepository);
                }
              }}
            >
              {syncingRepositoryName === selectedRepository?.name ? 'Syncing...' : 'Sync Selected'}
            </ActionButton>

            <ActionButton
              tone="primary"
              disabled={actionBlocked}
              aria-disabled={actionBlocked}
              onClick={() => {
                handleOpenAddForm();
              }}
            >
              Add Repository
            </ActionButton>

            {canLaunchWithSelectedRepository ? (
              <ButtonLink href="/runs" tone="primary">
                Launch Run with this repo
              </ButtonLink>
            ) : (
              <ActionButton tone="primary" disabled aria-disabled="true">
                Launch Run with this repo
              </ActionButton>
            )}
          </div>
          <p className="meta-text repo-add-hint">{addFormHint}</p>

          {isAddFormOpen ? (
            <section className="status-panel repo-add-form" aria-live="polite">
              <h4>Add repository</h4>
              <p className="meta-text">GitHub format: owner/repository. Add starts sync immediately after registration.</p>
              <label className="repo-add-form__field" htmlFor="repo-add-name">
                <span className="meta-text">Repository name</span>
                <input
                  id="repo-add-name"
                  name="repo-add-name"
                  value={newRepositoryName}
                  disabled={actionBlocked}
                  onChange={(event) => {
                    setNewRepositoryName(event.currentTarget.value);
                  }}
                  placeholder="frontend"
                />
              </label>
              <label className="repo-add-form__field" htmlFor="repo-add-github-ref">
                <span className="meta-text">GitHub repository</span>
                <input
                  id="repo-add-github-ref"
                  name="repo-add-github-ref"
                  value={newRepositoryRemoteRef}
                  disabled={actionBlocked}
                  onChange={(event) => {
                    setNewRepositoryRemoteRef(event.currentTarget.value);
                  }}
                  placeholder="octocat/frontend"
                />
              </label>
              {addRepositoryError ? <p className="repo-cell-error">{addRepositoryError}</p> : null}
              <div className="action-row">
                <ActionButton
                  tone="primary"
                  disabled={actionBlocked}
                  aria-disabled={actionBlocked}
                  onClick={() => {
                    void handleAddRepository();
                  }}
                >
                  {isAddingRepository ? 'Adding...' : 'Add and Sync'}
                </ActionButton>
                <ActionButton
                  disabled={isAddingRepository}
                  aria-disabled={isAddingRepository}
                  onClick={() => {
                    setIsAddFormOpen(false);
                    setAddRepositoryError(null);
                  }}
                >
                  Cancel
                </ActionButton>
              </div>
            </section>
          ) : null}

          <section className="status-panel" aria-live="polite">
            <p className="meta-text">CLI fallback remains available for repository registration.</p>
            <div className="page-stack">
              {REPO_REGISTRATION_COMMANDS.map(command => (
                <code key={command} className="code-preview">
                  {command}
                </code>
              ))}
            </div>
          </section>

          <AuthRemediation
            authGate={authGate}
            context="Repository sync is blocked until GitHub authentication is available."
          />
        </Panel>
      </div>
    </div>
  );
}
