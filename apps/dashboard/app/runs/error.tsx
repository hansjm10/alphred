'use client';

import { createRouteErrorBoundary } from '../ui/route-error-boundary';

const RunsError = createRouteErrorBoundary({
  title: 'Runs unavailable',
  message: 'Unable to load run summaries right now.',
  logPrefix: 'Runs route error:',
});

export default RunsError;
