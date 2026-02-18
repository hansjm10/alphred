'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from '../../ui/primitives';

type RunDetailErrorProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function RunDetailError({ error, reset }: RunDetailErrorProps) {
  useEffect(() => {
    console.error('Run detail route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Run detail unavailable" role="alert" aria-live="assertive">
        <p>Unable to load this run detail snapshot.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}

