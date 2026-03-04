'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DashboardArchiveRepositoryResult,
  DashboardCreateRepositoryResult,
  DashboardRepositoryState,
  DashboardRestoreRepositoryResult,
  DashboardRepositorySyncResult,
} from '@dashboard/server/dashboard-contracts';
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

function formatDateTimeLabel(date: Date): string {
  return date.toLocaleString();
}

function mapRepositoryStatusToBadge(
  repository: DashboardRepositoryState,
  cloneStatus: DashboardRepositoryState['cloneStatus'] | 'syncing',
): Readonly<{ status: StatusVariant; label: string }> {
  if (repository.archivedAt !== null) {
    return { status: 'paused', label: 'Archived' };
  }

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

function getAddFormHint(syncBlocked: boolean): string {
  if (syncBlocked) {
    return 'Dashboard add is blocked until GitHub authentication is restored. Use CLI commands below or re-authenticate.';
  }

  return 'Add Repository registers a GitHub repository and starts sync automatically.';
}

function resolveSyncErrorMessage(
  repository: DashboardRepositoryState,
  syncErrors: Readonly<Record<string, string>>,
): string | null {
  if (repository.archivedAt !== null) {
    return null;
  }

  const syncError = syncErrors[repository.name];
  if (syncError) {
    return syncError;
  }

  if (repository.cloneStatus === 'error') {
    return 'Latest sync failed. Retry to recover.';
  }

  return null;
}

function resolveSyncLabel(
  repository: DashboardRepositoryState,
  lastSyncLabels: Readonly<Record<string, string>>,
): string {
  if (repository.archivedAt !== null) {
    return `Archived ${formatDateTimeLabel(new Date(repository.archivedAt))}`;
  }

  const lastSyncLabel = lastSyncLabels[repository.name];
  if (lastSyncLabel) {
    return lastSyncLabel;
  }

  if (repository.cloneStatus === 'cloned') {
    return 'Available';
  }

  return 'Not synced';
}

function renderSyncBanner(syncBanner: SyncBanner | null): ReactNode {
  if (!syncBanner) {
    return null;
  }

  if (syncBanner.tone === 'error') {
    return (
      <p className={`repo-banner repo-banner--${syncBanner.tone}`} role="alert">
        {syncBanner.message}
      </p>
    );
  }

  return (
    <output className={`repo-banner repo-banner--${syncBanner.tone}`} aria-live="polite">
      {syncBanner.message}
    </output>
  );
}

function renderLocalPath(localPath: string | null, syncErrorMessage: string | null): ReactNode {
  if (localPath) {
    return <code className="repo-path">{localPath}</code>;
  }

  if (syncErrorMessage) {
    return <p className="repo-cell-error">{syncErrorMessage}</p>;
  }

  return <span className="meta-text">Path unavailable</span>;
}

function renderSelectedRepositoryDetails(
  selectedRepository: DashboardRepositoryState | null,
): ReactNode {
  if (!selectedRepository) {
    return <p>Select a repository to inspect details.</p>;
  }

  return (
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
      <li>
        <span>Lifecycle</span>
        <span>
          {selectedRepository.archivedAt === null
            ? 'Active'
            : `Archived (${formatDateTimeLabel(new Date(selectedRepository.archivedAt))})`}
        </span>
      </li>
    </ul>
  );
}

function renderLaunchAction(
  canLaunchWithSelectedRepository: boolean,
  selectedRepository: DashboardRepositoryState | null,
): ReactNode {
  if (canLaunchWithSelectedRepository && selectedRepository !== null) {
    const launchHref = `/runs?repository=${encodeURIComponent(selectedRepository.name)}`;

    return (
      <ButtonLink href={launchHref}>
        Launch Run with this repo
      </ButtonLink>
    );
  }

  return (
    <ActionButton disabled aria-disabled="true">
      Launch Run with this repo
    </ActionButton>
  );
}

function renderBoardAction(
  canOpenBoardWithSelectedRepository: boolean,
  selectedRepository: DashboardRepositoryState | null,
): ReactNode {
  if (canOpenBoardWithSelectedRepository && selectedRepository !== null) {
    const boardHref = `/repositories/${selectedRepository.id}/board`;

    return (
      <ButtonLink href={boardHref}>
        Open Board
      </ButtonLink>
    );
  }

  return (
    <ActionButton disabled aria-disabled="true">
      Open Board
    </ActionButton>
  );
}

function resolveSelectedArchiveActionLabel(
  selectedRepository: DashboardRepositoryState | null,
  isArchivingSelected: boolean,
  isRestoringSelected: boolean,
): string {
  if (selectedRepository?.archivedAt === null) {
    if (isArchivingSelected) {
      return 'Archiving...';
    }
    return 'Archive Selected';
  }

  if (isRestoringSelected) {
    return 'Restoring...';
  }
  return 'Restore Selected';
}

function onSyncSelectedRepository(
  selectedRepository: DashboardRepositoryState | null,
  onSyncRepository: (repository: DashboardRepositoryState) => Promise<void> | void,
): void {
  if (selectedRepository === null) {
    return;
  }

  onSyncRepository(selectedRepository);
}

function onArchiveActionForSelectedRepository(
  selectedRepository: DashboardRepositoryState | null,
  onArchiveRepository: (repository: DashboardRepositoryState) => Promise<void> | void,
  onRestoreRepository: (repository: DashboardRepositoryState) => Promise<void> | void,
): void {
  if (selectedRepository === null) {
    return;
  }

  if (selectedRepository.archivedAt === null) {
    onArchiveRepository(selectedRepository);
    return;
  }

  onRestoreRepository(selectedRepository);
}

type RepositoriesSelectedActionRowProps = Readonly<{
  syncSelectedTone: 'primary' | undefined;
  syncSelectedDisabled: boolean;
  selectedRepository: DashboardRepositoryState | null;
  syncingRepositoryName: string | null;
  shouldRenderAddRepositoryButton: boolean;
  actionBlocked: boolean;
  onOpenAddForm: () => void;
  shouldRenderLaunchAction: boolean;
  canLaunchWithSelectedRepository: boolean;
  shouldRenderBoardAction: boolean;
  canOpenBoardWithSelectedRepository: boolean;
  shouldRenderArchiveAction: boolean;
  selectedArchiveActionLabel: string;
  onSyncRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onArchiveRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onRestoreRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
}>;

function RepositoriesSelectedActionRow({
  syncSelectedTone,
  syncSelectedDisabled,
  selectedRepository,
  syncingRepositoryName,
  shouldRenderAddRepositoryButton,
  actionBlocked,
  onOpenAddForm,
  shouldRenderLaunchAction,
  canLaunchWithSelectedRepository,
  shouldRenderBoardAction,
  canOpenBoardWithSelectedRepository,
  shouldRenderArchiveAction,
  selectedArchiveActionLabel,
  onSyncRepository,
  onArchiveRepository,
  onRestoreRepository,
}: RepositoriesSelectedActionRowProps): ReactNode {
  return (
    <div className="action-row">
      <ActionButton
        tone={syncSelectedTone}
        disabled={syncSelectedDisabled}
        aria-disabled={syncSelectedDisabled}
        onClick={() => {
          onSyncSelectedRepository(selectedRepository, onSyncRepository);
        }}
      >
        {syncingRepositoryName === selectedRepository?.name ? 'Syncing...' : 'Sync Selected'}
      </ActionButton>

      {shouldRenderAddRepositoryButton ? (
        <ActionButton
          disabled={actionBlocked}
          aria-disabled={actionBlocked}
          onClick={() => {
            onOpenAddForm();
          }}
        >
          Add Repository
        </ActionButton>
      ) : null}

      {shouldRenderLaunchAction ? renderLaunchAction(canLaunchWithSelectedRepository, selectedRepository) : null}

      {shouldRenderBoardAction ? renderBoardAction(canOpenBoardWithSelectedRepository, selectedRepository) : null}

      {shouldRenderArchiveAction ? (
        <ActionButton
          disabled={actionBlocked}
          aria-disabled={actionBlocked}
          onClick={() => {
            onArchiveActionForSelectedRepository(
              selectedRepository,
              onArchiveRepository,
              onRestoreRepository,
            );
          }}
        >
          {selectedArchiveActionLabel}
        </ActionButton>
      ) : null}
    </div>
  );
}

type RepositoriesListCardProps = Readonly<{
  syncBanner: SyncBanner | null;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  showArchived: boolean;
  isRefreshingRepositoryList: boolean;
  isRepositoryMutationInFlight: boolean;
  onToggleShowArchived: (next: boolean) => Promise<void> | void;
  hasRepositories: boolean;
  isAddFormOpen: boolean;
  actionBlocked: boolean;
  addFormHint: string;
  filteredRepositories: readonly DashboardRepositoryState[];
  syncingRepositoryName: string | null;
  archivingRepositoryName: string | null;
  restoringRepositoryName: string | null;
  syncErrors: Readonly<Record<string, string>>;
  lastSyncLabels: Readonly<Record<string, string>>;
  selectedRepositoryName: string | null;
  onSelectRepositoryName: (name: string) => void;
  onOpenAddForm: () => void;
  onSyncRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onArchiveRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onRestoreRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
}>;

function RepositoriesListCard({
  syncBanner,
  searchQuery,
  onSearchQueryChange,
  showArchived,
  isRefreshingRepositoryList,
  isRepositoryMutationInFlight,
  onToggleShowArchived,
  hasRepositories,
  isAddFormOpen,
  actionBlocked,
  addFormHint,
  filteredRepositories,
  syncingRepositoryName,
  archivingRepositoryName,
  restoringRepositoryName,
  syncErrors,
  lastSyncLabels,
  selectedRepositoryName,
  onSelectRepositoryName,
  onOpenAddForm,
  onSyncRepository,
  onArchiveRepository,
  onRestoreRepository,
}: RepositoriesListCardProps): ReactNode {
  let repositoriesContent: ReactNode;
  if (!hasRepositories) {
    repositoriesContent = (
      <div className="page-stack">
        <h3>No repositories configured</h3>
        <p>Add a GitHub repository to register it and trigger sync from the dashboard.</p>
        <div className="action-row">
          <ActionButton
            tone={isAddFormOpen ? 'secondary' : 'primary'}
            disabled={actionBlocked}
            aria-disabled={actionBlocked}
            onClick={() => {
              onOpenAddForm();
            }}
          >
            Add Repository
          </ActionButton>
        </div>
        <p className="meta-text repo-add-hint">{addFormHint}</p>
      </div>
    );
  } else if (filteredRepositories.length === 0) {
    repositoriesContent = <p>No repositories match this filter.</p>;
  } else {
    repositoriesContent = (
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
              const isArchiving = archivingRepositoryName === repository.name;
              const isRestoring = restoringRepositoryName === repository.name;
              const isArchived = repository.archivedAt !== null;
              const cloneStatus = isSyncing ? 'syncing' : repository.cloneStatus;
              const badge = mapRepositoryStatusToBadge(repository, cloneStatus);
              const syncErrorMessage = resolveSyncErrorMessage(repository, syncErrors);
              const actionLabel = repository.cloneStatus === 'error' ? 'Retry' : 'Sync';
              const actionText = isSyncing ? 'Syncing...' : actionLabel;
              const archiveText = isArchiving ? 'Archiving...' : 'Archive';
              const restoreText = isRestoring ? 'Restoring...' : 'Restore';
              const syncLabel = resolveSyncLabel(repository, lastSyncLabels);
              const selected = selectedRepositoryName === repository.name;
              const rowClassName = selected ? 'repositories-row--selected' : undefined;

              return (
                <tr key={repository.id} className={rowClassName}>
                  <td>
                    <button
                      className="repo-name-button"
                      onClick={() => {
                        onSelectRepositoryName(repository.name);
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
                  <td>{renderLocalPath(repository.localPath, syncErrorMessage)}</td>
                  <td className="meta-text">{syncLabel}</td>
                  <td>
                    <div className="repo-table-actions">
                      {isArchived ? (
                        <ActionButton
                          aria-label={`Restore ${repository.name}`}
                          disabled={actionBlocked}
                          aria-disabled={actionBlocked}
                          onClick={() => {
                            onRestoreRepository(repository);
                          }}
                        >
                          {restoreText}
                        </ActionButton>
                      ) : (
                        <>
                          <ActionButton
                            aria-label={`${actionLabel} ${repository.name}`}
                            disabled={actionBlocked}
                            aria-disabled={actionBlocked}
                            onClick={() => {
                              onSyncRepository(repository);
                            }}
                          >
                            {actionText}
                          </ActionButton>
                          <ActionButton
                            aria-label={`Archive ${repository.name}`}
                            disabled={actionBlocked}
                            aria-disabled={actionBlocked}
                            onClick={() => {
                              onArchiveRepository(repository);
                            }}
                          >
                            {archiveText}
                          </ActionButton>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Card title="Repositories" description="Name, provider, clone state, local path, and sync actions.">
      {renderSyncBanner(syncBanner)}

      <div className="repositories-toolbar">
        <label className="repositories-search" htmlFor="repositories-search">
          <span className="meta-text">Search repositories</span>
          <input
            id="repositories-search"
            name="repositories-search"
            value={searchQuery}
            onChange={(event) => {
              onSearchQueryChange(event.currentTarget.value);
            }}
            placeholder="Search name, provider, or remote ref"
          />
        </label>
        <label className="repo-show-archived">
          <input
            type="checkbox"
            checked={showArchived}
            disabled={isRefreshingRepositoryList || isRepositoryMutationInFlight}
            onChange={(event) => {
              onToggleShowArchived(event.currentTarget.checked);
            }}
          />
          <span>{isRefreshingRepositoryList ? 'Refreshing...' : 'Show archived'}</span>
        </label>
      </div>

      {repositoriesContent}
    </Card>
  );
}

type RepositoriesAddFormProps = Readonly<{
  actionBlocked: boolean;
  isAddingRepository: boolean;
  newRepositoryName: string;
  newRepositoryRemoteRef: string;
  addRepositoryError: string | null;
  onChangeNewRepositoryName: (next: string) => void;
  onChangeNewRepositoryRemoteRef: (next: string) => void;
  onAddRepository: () => Promise<void> | void;
  onCancel: () => void;
}>;

function RepositoriesAddForm({
  actionBlocked,
  isAddingRepository,
  newRepositoryName,
  newRepositoryRemoteRef,
  addRepositoryError,
  onChangeNewRepositoryName,
  onChangeNewRepositoryRemoteRef,
  onAddRepository,
  onCancel,
}: RepositoriesAddFormProps): ReactNode {
  return (
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
            onChangeNewRepositoryName(event.currentTarget.value);
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
            onChangeNewRepositoryRemoteRef(event.currentTarget.value);
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
	            onAddRepository();
	          }}
	        >
	          {isAddingRepository ? 'Adding...' : 'Add and Sync'}
	        </ActionButton>
        <ActionButton
          disabled={isAddingRepository}
          aria-disabled={isAddingRepository}
          onClick={() => {
            onCancel();
          }}
        >
          Cancel
        </ActionButton>
      </div>
    </section>
  );
}

type RepositoriesActionsPanelProps = Readonly<{
  authGate: GitHubAuthGate;
  selectedRepository: DashboardRepositoryState | null;
  selectedRepositorySyncError?: string;
  actionBlocked: boolean;
  hasRepositories: boolean;
  isAddFormOpen: boolean;
  addFormHint: string;
  syncingRepositoryName: string | null;
  archivingRepositoryName: string | null;
  restoringRepositoryName: string | null;
  canLaunchWithSelectedRepository: boolean;
  canOpenBoardWithSelectedRepository: boolean;
  onOpenAddForm: () => void;
  onSyncRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onArchiveRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onRestoreRepository: (repository: DashboardRepositoryState) => Promise<void> | void;
  onAddRepository: () => Promise<void> | void;
  newRepositoryName: string;
  newRepositoryRemoteRef: string;
  addRepositoryError: string | null;
  isAddingRepository: boolean;
  onChangeNewRepositoryName: (next: string) => void;
  onChangeNewRepositoryRemoteRef: (next: string) => void;
  onCancelAddForm: () => void;
}>;

function RepositoriesActionsPanel({
  authGate,
  selectedRepository,
  selectedRepositorySyncError,
  actionBlocked,
  hasRepositories,
  isAddFormOpen,
  addFormHint,
  syncingRepositoryName,
  archivingRepositoryName,
  restoringRepositoryName,
  canLaunchWithSelectedRepository,
  canOpenBoardWithSelectedRepository,
  onOpenAddForm,
  onSyncRepository,
  onArchiveRepository,
  onRestoreRepository,
  onAddRepository,
  newRepositoryName,
  newRepositoryRemoteRef,
  addRepositoryError,
  isAddingRepository,
  onChangeNewRepositoryName,
  onChangeNewRepositoryRemoteRef,
  onCancelAddForm,
}: RepositoriesActionsPanelProps): ReactNode {
  const syncSelectedDisabled =
    selectedRepository?.archivedAt !== null || actionBlocked;
  const syncSelectedTone = isAddFormOpen ? undefined : 'primary';
  const shouldRenderAddRepositoryButton = hasRepositories && !isAddFormOpen;
  const shouldRenderLaunchAction = hasRepositories && !isAddFormOpen;
  const shouldRenderBoardAction = hasRepositories && !isAddFormOpen;
  const shouldRenderArchiveAction = selectedRepository !== null && !isAddFormOpen;
  const isArchivingSelected = selectedRepository !== null && archivingRepositoryName === selectedRepository.name;
  const isRestoringSelected = selectedRepository !== null && restoringRepositoryName === selectedRepository.name;
  const selectedArchiveActionLabel = resolveSelectedArchiveActionLabel(
    selectedRepository,
    isArchivingSelected,
    isRestoringSelected,
  );

  return (
    <Panel title="Repository actions" description="Select a row to inspect details and run sync.">
      <p className="meta-text">{`GitHub auth: ${authGate.badge.label}`}</p>

      {renderSelectedRepositoryDetails(selectedRepository)}

      {selectedRepositorySyncError ? <p className="repo-cell-error">{selectedRepositorySyncError}</p> : null}

      <RepositoriesSelectedActionRow
        syncSelectedTone={syncSelectedTone}
        syncSelectedDisabled={syncSelectedDisabled}
        selectedRepository={selectedRepository}
        syncingRepositoryName={syncingRepositoryName}
        shouldRenderAddRepositoryButton={shouldRenderAddRepositoryButton}
        actionBlocked={actionBlocked}
        onOpenAddForm={onOpenAddForm}
        shouldRenderLaunchAction={shouldRenderLaunchAction}
        canLaunchWithSelectedRepository={canLaunchWithSelectedRepository}
        shouldRenderBoardAction={shouldRenderBoardAction}
        canOpenBoardWithSelectedRepository={canOpenBoardWithSelectedRepository}
        shouldRenderArchiveAction={shouldRenderArchiveAction}
        selectedArchiveActionLabel={selectedArchiveActionLabel}
        onSyncRepository={onSyncRepository}
        onArchiveRepository={onArchiveRepository}
        onRestoreRepository={onRestoreRepository}
      />
      <p className="meta-text repo-add-hint">{addFormHint}</p>

      {isAddFormOpen ? (
        <RepositoriesAddForm
          actionBlocked={actionBlocked}
          isAddingRepository={isAddingRepository}
          newRepositoryName={newRepositoryName}
          newRepositoryRemoteRef={newRepositoryRemoteRef}
          addRepositoryError={addRepositoryError}
          onChangeNewRepositoryName={onChangeNewRepositoryName}
          onChangeNewRepositoryRemoteRef={onChangeNewRepositoryRemoteRef}
          onAddRepository={onAddRepository}
          onCancel={onCancelAddForm}
        />
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
  );
}

export function RepositoriesPageContent({
  repositories,
  authGate,
}: RepositoriesPageContentProps) {
  const [repositoryState, setRepositoryState] = useState<readonly DashboardRepositoryState[]>(repositories);
  const [selectedRepositoryName, setSelectedRepositoryName] = useState<string | null>(repositoryState[0]?.name ?? null);
  const [syncingRepositoryName, setSyncingRepositoryName] = useState<string | null>(null);
  const [archivingRepositoryName, setArchivingRepositoryName] = useState<string | null>(null);
  const [restoringRepositoryName, setRestoringRepositoryName] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const showArchivedRef = useRef(showArchived);
  const repositoryStateRef = useRef(repositoryState);
  const refreshRequestSequenceRef = useRef(0);
  repositoryStateRef.current = repositoryState;
  const [isRefreshingRepositoryList, setIsRefreshingRepositoryList] = useState(false);
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
  const isRepositoryMutationInFlight =
    syncingRepositoryName !== null
    || archivingRepositoryName !== null
    || restoringRepositoryName !== null
    || isAddingRepository;
  const actionBlocked =
    syncBlocked
    || isRepositoryMutationInFlight
    || isRefreshingRepositoryList;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasRepositories = repositoryState.length > 0;

  const filteredRepositories = useMemo(
    () => repositoryState.filter(repository => filterRepository(repository, normalizedQuery)),
    [normalizedQuery, repositoryState],
  );

  const selectedRepository = useMemo(() => {
    if (filteredRepositories.length === 0) {
      return null;
    }

    return (
      filteredRepositories.find(repository => repository.name === selectedRepositoryName) ?? filteredRepositories[0] ?? null
    );
  }, [filteredRepositories, selectedRepositoryName]);
  const selectedRepositorySyncError = selectedRepository ? syncErrors[selectedRepository.name] : undefined;
  const canLaunchWithSelectedRepository =
    selectedRepository !== null
    && selectedRepository.archivedAt === null
    && selectedRepository.cloneStatus === 'cloned'
    && authGate.canMutate;
  const canOpenBoardWithSelectedRepository = selectedRepository !== null && selectedRepository.archivedAt === null;
  const addFormHint = getAddFormHint(syncBlocked);

  function applyRepositoriesSnapshot(nextRepositories: readonly DashboardRepositoryState[]): void {
    setRepositoryState(nextRepositories);
    setSelectedRepositoryName(currentSelection => {
      if (currentSelection && nextRepositories.some(repository => repository.name === currentSelection)) {
        return currentSelection;
      }

      return nextRepositories[0]?.name ?? null;
    });

    const names = new Set(nextRepositories.map(repository => repository.name));
    setSyncErrors(current =>
      Object.fromEntries(Object.entries(current).filter(([name]) => names.has(name))),
    );
    setLastSyncLabels(current =>
      Object.fromEntries(Object.entries(current).filter(([name]) => names.has(name))),
    );
  }

  function applyRepositoryMutationResult(
    nextRepository: DashboardRepositoryState,
    includeArchived: boolean,
  ): void {
    const currentRepositories = repositoryStateRef.current;
    const shouldIncludeRepository = includeArchived || nextRepository.archivedAt === null;
    let nextRepositories = currentRepositories.filter(repository => repository.name !== nextRepository.name);
    if (shouldIncludeRepository) {
      if (currentRepositories.some(repository => repository.name === nextRepository.name)) {
        nextRepositories = currentRepositories.map(repository =>
          repository.name === nextRepository.name ? nextRepository : repository,
        );
      } else {
        nextRepositories = [...currentRepositories, nextRepository];
      }
    }

    applyRepositoriesSnapshot(nextRepositories);
  }

  async function fetchRepositories(includeArchived: boolean): Promise<readonly DashboardRepositoryState[]> {
    const response = await fetch(
      includeArchived
        ? '/api/dashboard/repositories?includeArchived=1'
        : '/api/dashboard/repositories',
      { method: 'GET' },
    );
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new Error(resolveApiErrorMessage(response.status, payload, 'Repository list refresh failed'));
    }

    if (
      typeof payload !== 'object'
      || payload === null
      || !('repositories' in payload)
      || !Array.isArray((payload as { repositories?: unknown }).repositories)
    ) {
      throw new Error('Repository list refresh failed (unexpected response shape).');
    }

    return (payload as { repositories: readonly DashboardRepositoryState[] }).repositories;
  }

  type RefreshRepositoriesResult = 'applied' | 'stale';

  async function refreshRepositories(includeArchived: boolean): Promise<RefreshRepositoriesResult> {
    const requestSequence = refreshRequestSequenceRef.current + 1;
    refreshRequestSequenceRef.current = requestSequence;
    setIsRefreshingRepositoryList(true);

    try {
      const nextRepositories = await fetchRepositories(includeArchived);
      if (refreshRequestSequenceRef.current !== requestSequence) {
        return 'stale';
      }
      applyRepositoriesSnapshot(nextRepositories);
      showArchivedRef.current = includeArchived;
      setShowArchived(includeArchived);
      return 'applied';
    } catch (error) {
      if (refreshRequestSequenceRef.current !== requestSequence) {
        return 'stale';
      }
      throw error;
    } finally {
      if (refreshRequestSequenceRef.current === requestSequence) {
        setIsRefreshingRepositoryList(false);
      }
    }
  }

  async function handleSync(repository: DashboardRepositoryState): Promise<void> {
    if (repository.archivedAt !== null || syncBlocked || actionBlocked) {
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
        message: `${result.repository.name} sync completed (${result.action}, ${result.sync.status}).`,
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

  async function handleToggleShowArchived(next: boolean): Promise<void> {
    if (isRefreshingRepositoryList || isRepositoryMutationInFlight) {
      return;
    }

    setSyncBanner(null);
    const previousIncludeArchived = showArchivedRef.current;
    showArchivedRef.current = next;

    try {
      const refreshResult = await refreshRepositories(next);
      if (refreshResult === 'stale') {
        setShowArchived(showArchivedRef.current);
      }
    } catch (error) {
      showArchivedRef.current = previousIncludeArchived;
      const message = error instanceof Error ? error.message : 'Repository list refresh failed.';
      setSyncBanner({
        tone: 'error',
        message,
      });
    }
  }

  async function handleArchive(repository: DashboardRepositoryState): Promise<void> {
    if (repository.archivedAt !== null || syncBlocked || actionBlocked) {
      return;
    }

    setSelectedRepositoryName(repository.name);
    setSyncBanner(null);
    setArchivingRepositoryName(repository.name);

    try {
      const response = await fetch(
        `/api/dashboard/repositories/${encodeURIComponent(repository.name)}/actions/archive`,
        { method: 'POST' },
      );
      const payload = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Repository archive failed'));
      }

      const result = payload as DashboardArchiveRepositoryResult;
      const includeArchived = showArchivedRef.current;
      applyRepositoryMutationResult(result.repository, includeArchived);

      try {
        await refreshRepositories(includeArchived);
        setSyncBanner({
          tone: 'success',
          message: `${result.repository.name} archived.`,
        });
      } catch (error) {
        const refreshMessage = error instanceof Error ? error.message : 'Repository list refresh failed.';
        setSyncBanner({
          tone: 'error',
          message: `${result.repository.name} archived, but ${refreshMessage}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repository archive failed.';
      setSyncBanner({
        tone: 'error',
        message,
      });
    } finally {
      setArchivingRepositoryName(null);
    }
  }

  async function handleRestore(repository: DashboardRepositoryState): Promise<void> {
    if (repository.archivedAt === null || syncBlocked || actionBlocked) {
      return;
    }

    setSelectedRepositoryName(repository.name);
    setSyncBanner(null);
    setRestoringRepositoryName(repository.name);

    try {
      const response = await fetch(
        `/api/dashboard/repositories/${encodeURIComponent(repository.name)}/actions/restore`,
        { method: 'POST' },
      );
      const payload = (await response.json().catch(() => null)) as unknown;

      if (!response.ok) {
        throw new Error(resolveApiErrorMessage(response.status, payload, 'Repository restore failed'));
      }

      const result = payload as DashboardRestoreRepositoryResult;
      const includeArchived = showArchivedRef.current;
      applyRepositoryMutationResult(result.repository, includeArchived);

      try {
        await refreshRepositories(includeArchived);
        setSyncBanner({
          tone: 'success',
          message: `${result.repository.name} restored.`,
        });
      } catch (error) {
        const refreshMessage = error instanceof Error ? error.message : 'Repository list refresh failed.';
        setSyncBanner({
          tone: 'error',
          message: `${result.repository.name} restored, but ${refreshMessage}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repository restore failed.';
      setSyncBanner({
        tone: 'error',
        message,
      });
    } finally {
      setRestoringRepositoryName(null);
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
        <RepositoriesListCard
          syncBanner={syncBanner}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          showArchived={showArchived}
          isRefreshingRepositoryList={isRefreshingRepositoryList}
          isRepositoryMutationInFlight={isRepositoryMutationInFlight}
          onToggleShowArchived={handleToggleShowArchived}
          hasRepositories={hasRepositories}
          isAddFormOpen={isAddFormOpen}
          actionBlocked={actionBlocked}
          addFormHint={addFormHint}
          filteredRepositories={filteredRepositories}
          syncingRepositoryName={syncingRepositoryName}
          archivingRepositoryName={archivingRepositoryName}
          restoringRepositoryName={restoringRepositoryName}
          syncErrors={syncErrors}
          lastSyncLabels={lastSyncLabels}
          selectedRepositoryName={selectedRepository?.name ?? null}
          onSelectRepositoryName={setSelectedRepositoryName}
          onOpenAddForm={handleOpenAddForm}
          onSyncRepository={handleSync}
          onArchiveRepository={handleArchive}
          onRestoreRepository={handleRestore}
        />

        <RepositoriesActionsPanel
          authGate={authGate}
          selectedRepository={selectedRepository}
          selectedRepositorySyncError={selectedRepositorySyncError}
          actionBlocked={actionBlocked}
          hasRepositories={hasRepositories}
          isAddFormOpen={isAddFormOpen}
          addFormHint={addFormHint}
          syncingRepositoryName={syncingRepositoryName}
          archivingRepositoryName={archivingRepositoryName}
          restoringRepositoryName={restoringRepositoryName}
          canLaunchWithSelectedRepository={canLaunchWithSelectedRepository}
          canOpenBoardWithSelectedRepository={canOpenBoardWithSelectedRepository}
          onOpenAddForm={handleOpenAddForm}
          onSyncRepository={handleSync}
          onArchiveRepository={handleArchive}
          onRestoreRepository={handleRestore}
          onAddRepository={handleAddRepository}
          newRepositoryName={newRepositoryName}
          newRepositoryRemoteRef={newRepositoryRemoteRef}
          addRepositoryError={addRepositoryError}
          isAddingRepository={isAddingRepository}
          onChangeNewRepositoryName={setNewRepositoryName}
          onChangeNewRepositoryRemoteRef={setNewRepositoryRemoteRef}
          onCancelAddForm={() => {
            setIsAddFormOpen(false);
            setAddRepositoryError(null);
          }}
        />
      </div>
    </div>
  );
}
