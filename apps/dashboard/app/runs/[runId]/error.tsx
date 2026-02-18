'use client';

import { RouteErrorBoundary, type RouteErrorBoundaryProps } from '../../ui/route-error-boundary';

type RunDetailErrorProps = Readonly<{
  error: RouteErrorBoundaryProps['error'];
  reset: RouteErrorBoundaryProps['reset'];
}>;

export default function RunDetailError({ error, reset }: RunDetailErrorProps) {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      title="Run detail unavailable"
      message="Unable to load this run detail snapshot."
      logPrefix="Run detail route error:"
    />
  );
}
