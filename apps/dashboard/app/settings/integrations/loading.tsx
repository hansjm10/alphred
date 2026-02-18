import { Card } from '../../ui/primitives';

export default function IntegrationsLoading() {
  return (
    <div className="page-stack">
      <Card title="Loading integrations">
        <output aria-live="polite">Checking GitHub authentication status...</output>
      </Card>
    </div>
  );
}
