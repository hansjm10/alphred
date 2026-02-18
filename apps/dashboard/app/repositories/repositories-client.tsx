'use client';

import { useMemo, useState } from 'react';
import type {
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

type SyncErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const REPO_REGISTRATION_COMMANDS = [
  'alphred repo add --provider github --ref owner/repository',
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

function resolveSyncErrorMessage(status: number, payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as SyncErrorEnvelope).error === 'object' &&
    (payload as SyncErrorEnvelope).error !== null &&
    typeof (payload as SyncErrorEnvelope).error?.message === 'string'
  ) {
    return (payload as SyncErrorEnvelope).error?.message as string;
  }

  return `Repository sync failed (HTTP ${status}).`;
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

  const syncBlocked = !authGate.canMutate;
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

  async function handleSync(repository: DashboardRepositoryState): Promise<void> {
    if (syncBlocked || syncingRepositoryName !== null) {
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
        throw new Error(resolveSyncErrorMessage(response.status, payload));
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
              <p>Add a repository with CLI primitives, then sync it from the dashboard.</p>
              <div className="action-row">
                <ActionButton tone="primary" disabled aria-disabled="true">
                  Add Repository
                </ActionButton>
              </div>
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
                            disabled={syncBlocked || isSyncing}
                            aria-disabled={syncBlocked || isSyncing}
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
              disabled={selectedRepository === null || syncBlocked || syncingRepositoryName !== null}
              aria-disabled={selectedRepository === null || syncBlocked || syncingRepositoryName !== null}
              onClick={() => {
                if (selectedRepository) {
                  void handleSync(selectedRepository);
                }
              }}
            >
              {syncingRepositoryName === selectedRepository?.name ? 'Syncing...' : 'Sync Selected'}
            </ActionButton>

            <ActionButton tone="primary" disabled aria-disabled="true">
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

          <section className="status-panel" aria-live="polite">
            <p className="meta-text">Repository registration uses existing CLI flows.</p>
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
