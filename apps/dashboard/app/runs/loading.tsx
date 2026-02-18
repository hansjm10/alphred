import { Card } from '../ui/primitives';

export default function RunsLoading() {
  return (
    <div className="page-stack">
      <Card title="Loading runs">
        <output aria-live="polite">Loading run lifecycle data...</output>
      </Card>
    </div>
  );
}

