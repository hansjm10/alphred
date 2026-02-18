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
}>;

export default function RepositoriesPage({ repositories = DEFAULT_REPOSITORIES }: RepositoriesPageProps = {}) {
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
          <div className="action-row">
            <ActionButton disabled={repositories.length === 0} aria-disabled={repositories.length === 0}>
              Sync Selected
            </ActionButton>
            <ActionButton tone="primary">Add Repository</ActionButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}
