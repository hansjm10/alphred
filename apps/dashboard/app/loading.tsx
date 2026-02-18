import { Card } from './ui/primitives';

export default function Loading() {
  return (
    <div className="page-stack">
      <Card title="Loading dashboard">
        <output aria-live="polite">
          Preparing workflow run data...
        </output>
      </Card>
    </div>
  );
}
