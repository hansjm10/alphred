import { cache } from 'react';
import { createDashboardService } from '../../src/server/dashboard-service';
import { createGitHubAuthErrorGate, createGitHubAuthGate, type GitHubAuthGate } from './github-auth';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export const loadGitHubAuthGate = cache(async (): Promise<GitHubAuthGate> => {
  const checkedAt = new Date();
  const service = createDashboardService();

  try {
    const auth = await service.checkGitHubAuth();
    return createGitHubAuthGate(auth, checkedAt);
  } catch (error) {
    return createGitHubAuthErrorGate(toErrorMessage(error), checkedAt);
  }
});
