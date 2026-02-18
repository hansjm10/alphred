'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from '../ui/primitives';

type RunsErrorProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function RunsError({ error, reset }: RunsErrorProps) {
  useEffect(() => {
    console.error('Runs route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Runs unavailable" role="alert" aria-live="assertive">
        <p>Unable to load run summaries right now.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}

