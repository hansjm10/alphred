'use client';

import { RouteErrorBoundary, type RouteErrorBoundaryProps } from '../ui/route-error-boundary';

type RunsErrorProps = Readonly<{
  error: RouteErrorBoundaryProps['error'];
  reset: RouteErrorBoundaryProps['reset'];
}>;

export default function RunsError({ error, reset }: RunsErrorProps) {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      title="Runs unavailable"
      message="Unable to load run summaries right now."
      logPrefix="Runs route error:"
    />
  );
}
