'use client';

import { RouteErrorBoundary, type RouteErrorBoundaryProps } from '../ui/route-error-boundary';

type RepositoriesErrorProps = Readonly<{
  error: RouteErrorBoundaryProps['error'];
  reset: RouteErrorBoundaryProps['reset'];
}>;

export default function RepositoriesError({ error, reset }: RepositoriesErrorProps) {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      title="Repositories unavailable"
      message="Unable to load repository registry data."
      logPrefix="Repositories route error:"
    />
  );
}
