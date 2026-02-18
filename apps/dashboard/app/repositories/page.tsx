import { AuthRemediation } from '../ui/auth-remediation';
import type { GitHubAuthGate } from '../ui/github-auth';
import { loadGitHubAuthGate } from '../ui/load-github-auth-gate';
import { ActionButton, Card, Panel, StatusBadge } from '../ui/primitives';

type RepositoryStatus = 'pending' | 'completed' | 'failed';

type RepositoryRecord = Readonly<{
  name: string;
  status: RepositoryStatus;
  label: string;
}>;

const DEFAULT_REPOSITORIES: readonly RepositoryRecord[] = [
  { name: 'demo-repo', status: 'completed', label: 'Cloned' },
  { name: 'sample-repo', status: 'failed', label: 'Sync error' },
  { name: 'new-repo', status: 'pending', label: 'Not synced' },
];

type RepositoriesPageProps = Readonly<{
  repositories?: readonly RepositoryRecord[];
  authGate?: GitHubAuthGate;
}>;

export function RepositoriesPageContent({
  repositories,
  authGate,
}: Readonly<{
  repositories: readonly RepositoryRecord[];
  authGate: GitHubAuthGate;
}>) {
  const syncBlocked = repositories.length === 0 || !authGate.canMutate;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Repository registry</h2>
        <p>Track clone lifecycle state and keep launch targets ready.</p>
      </section>

      <div className="page-grid">
        <Card title="Repositories" description="Shared status component variants">
          {repositories.length === 0 ? (
            <div className="page-stack">
              <h3>No repositories configured</h3>
              <p>Add a repository to start sync and run workflows.</p>
              <div className="action-row">
                <ActionButton tone="primary">Add Repository</ActionButton>
              </div>
            </div>
          ) : (
            <ul className="entity-list">
              {repositories.map((repository) => (
                <li key={repository.name}>
                  <span>{repository.name}</span>
                  <StatusBadge status={repository.status} label={repository.label} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Panel title="Repository actions" description="Action surface using shared button primitives">
          <p className="meta-text">{`GitHub auth: ${authGate.badge.label}`}</p>
          <div className="action-row">
            <ActionButton disabled={syncBlocked} aria-disabled={syncBlocked}>
              Sync Selected
            </ActionButton>
            <ActionButton tone="primary">Add Repository</ActionButton>
          </div>
          <AuthRemediation
            authGate={authGate}
            context="Repository sync is blocked until GitHub authentication is available."
          />
        </Panel>
      </div>
    </div>
  );
}

export default async function RepositoriesPage({
  repositories = DEFAULT_REPOSITORIES,
  authGate,
}: RepositoriesPageProps = {}) {
  const resolvedAuthGate = authGate ?? (await loadGitHubAuthGate());

  return <RepositoriesPageContent repositories={repositories} authGate={resolvedAuthGate} />;
}
