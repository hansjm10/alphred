import { Card } from '../ui/primitives';

export default function RepositoriesLoading() {
  return (
    <div className="page-stack">
      <Card title="Loading repositories">
        <output aria-live="polite">Checking clone status and sync state...</output>
      </Card>
    </div>
  );
}

