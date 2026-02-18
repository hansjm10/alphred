'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from '../../ui/primitives';

type IntegrationsErrorProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function IntegrationsError({ error, reset }: IntegrationsErrorProps) {
  useEffect(() => {
    console.error('Integrations route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Integrations unavailable" role="alert" aria-live="assertive">
        <p>Unable to load integration authentication status.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}
