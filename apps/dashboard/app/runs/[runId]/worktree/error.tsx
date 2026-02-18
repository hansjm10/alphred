'use client';

import { RouteErrorBoundary, type RouteErrorBoundaryProps } from '../../../ui/route-error-boundary';

type RunWorktreeErrorProps = Readonly<{
  error: RouteErrorBoundaryProps['error'];
  reset: RouteErrorBoundaryProps['reset'];
}>;

export default function RunWorktreeError({ error, reset }: RunWorktreeErrorProps) {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      title="Worktree unavailable"
      message="Unable to load worktree files for this run."
      logPrefix="Run worktree route error:"
    />
  );
}
