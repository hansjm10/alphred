'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from '../ui/primitives';

type RepositoriesErrorProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function RepositoriesError({ error, reset }: RepositoriesErrorProps) {
  useEffect(() => {
    console.error('Repositories route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Repositories unavailable" role="alert" aria-live="assertive">
        <p>Unable to load repository registry data.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}

