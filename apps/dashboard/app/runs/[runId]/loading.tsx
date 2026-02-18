import { Card } from '../../ui/primitives';

export default function RunDetailLoading() {
  return (
    <div className="page-stack">
      <Card title="Loading run detail">
        <output aria-live="polite">Fetching timeline and node lifecycle...</output>
      </Card>
    </div>
  );
}

