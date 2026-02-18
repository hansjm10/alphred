'use client';

import { createRouteErrorBoundary } from '../../ui/route-error-boundary';

const RunDetailError = createRouteErrorBoundary({
  title: 'Run detail unavailable',
  message: 'Unable to load this run detail snapshot.',
  logPrefix: 'Run detail route error:',
});

export default RunDetailError;
