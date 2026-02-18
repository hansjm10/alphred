import { ActionButton, Card, Panel, StatusBadge } from '../ui/primitives';

export default function RepositoriesPage() {
  return (
    <div className="page-stack">
      <section className="page-heading">
        <h2>Repository registry</h2>
        <p>Track clone lifecycle state and keep launch targets ready.</p>
      </section>

      <div className="page-grid">
        <Card title="Repositories" description="Shared status component variants">
          <ul className="entity-list">
            <li>
              <span>demo-repo</span>
              <StatusBadge status="completed" label="Cloned" />
            </li>
            <li>
              <span>sample-repo</span>
              <StatusBadge status="failed" label="Sync error" />
            </li>
            <li>
              <span>new-repo</span>
              <StatusBadge status="pending" label="Not synced" />
            </li>
          </ul>
        </Card>

        <Panel title="Repository actions" description="Action surface using shared button primitives">
          <div className="action-row">
            <ActionButton>Sync Selected</ActionButton>
            <ActionButton tone="primary">Add Repository</ActionButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}
