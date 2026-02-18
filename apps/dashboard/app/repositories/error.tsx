'use client';

import { createRouteErrorBoundary } from '../ui/route-error-boundary';

const RepositoriesError = createRouteErrorBoundary({
  title: 'Repositories unavailable',
  message: 'Unable to load repository registry data.',
  logPrefix: 'Repositories route error:',
});

export default RepositoriesError;
