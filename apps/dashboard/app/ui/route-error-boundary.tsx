'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from './primitives';

export type RouteErrorBoundaryProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
  title: string;
  message: string;
  logPrefix: string;
}>;

export function RouteErrorBoundary({
  error,
  reset,
  title,
  message,
  logPrefix,
}: RouteErrorBoundaryProps) {
  useEffect(() => {
    console.error(logPrefix, error);
  }, [error, logPrefix]);

  return (
    <div className="page-stack">
      <Card title={title} role="alert" aria-live="assertive">
        <p>{message}</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}
