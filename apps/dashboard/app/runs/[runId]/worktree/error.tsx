'use client';

import { createRouteErrorBoundary } from '../../../ui/route-error-boundary';

const RunWorktreeError = createRouteErrorBoundary({
  title: 'Worktree unavailable',
  message: 'Unable to load worktree files for this run.',
  logPrefix: 'Run worktree route error:',
});

export default RunWorktreeError;
