'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from './ui/primitives';

type ErrorPageProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function DashboardError({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Dashboard error" role="alert" aria-live="assertive">
        <p>Something went wrong while loading this route.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Try again</ActionButton>
        </div>
      </Card>
    </div>
  );
}
