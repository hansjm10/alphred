import { cache } from 'react';
import { createDashboardService } from '../../src/server/dashboard-service';
import { createGitHubAuthErrorGate, createGitHubAuthGate, type GitHubAuthGate } from './github-auth';

function logAuthGateLoadFailure(error: unknown): void {
  if (error instanceof Error) {
    console.error('Dashboard GitHub auth gate check failed.', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return;
  }

  console.error('Dashboard GitHub auth gate check failed.', {
    message: String(error),
  });
}

export const loadGitHubAuthGate = cache(async (): Promise<GitHubAuthGate> => {
  const checkedAt = new Date();
  const service = createDashboardService();

  try {
    const auth = await service.checkGitHubAuth();
    return createGitHubAuthGate(auth, checkedAt);
  } catch (error) {
    logAuthGateLoadFailure(error);
    return createGitHubAuthErrorGate(undefined, checkedAt);
  }
});
