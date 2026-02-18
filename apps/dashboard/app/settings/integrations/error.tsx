'use client';

import { RouteErrorBoundary, type RouteErrorBoundaryProps } from '../../ui/route-error-boundary';

type IntegrationsErrorProps = Readonly<{
  error: RouteErrorBoundaryProps['error'];
  reset: RouteErrorBoundaryProps['reset'];
}>;

export default function IntegrationsError({ error, reset }: IntegrationsErrorProps) {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      title="Integrations unavailable"
      message="Unable to load integration authentication status."
      logPrefix="Integrations route error:"
    />
  );
}
