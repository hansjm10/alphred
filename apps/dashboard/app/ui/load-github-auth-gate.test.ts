import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardGitHubAuthStatus } from '../../src/server/dashboard-contracts';

async function loadModuleWithAuthCheck(
  checkGitHubAuthImpl: () => Promise<DashboardGitHubAuthStatus>,
): Promise<{
  loadGitHubAuthGate: () => Promise<import('./github-auth').GitHubAuthGate>;
  checkGitHubAuth: ReturnType<typeof vi.fn>;
}> {
  const checkGitHubAuth = vi.fn(checkGitHubAuthImpl);

  vi.doMock('../../src/server/dashboard-service', () => ({
    createDashboardService: () => ({
      checkGitHubAuth,
    }),
  }));

  const loadedModule = await import('./load-github-auth-gate');
  return {
    loadGitHubAuthGate: loadedModule.loadGitHubAuthGate,
    checkGitHubAuth,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('loadGitHubAuthGate', () => {
  it('returns an authenticated gate when service auth check succeeds', async () => {
    const { loadGitHubAuthGate, checkGitHubAuth } = await loadModuleWithAuthCheck(async () => ({
      authenticated: true,
      user: 'octocat',
      scopes: ['repo'],
      error: null,
    }));

    const gate = await loadGitHubAuthGate();

    expect(checkGitHubAuth).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe('authenticated');
    expect(gate.canMutate).toBe(true);
    expect(gate.badge.label).toBe('Authenticated');
    expect(gate.detail).toContain('Signed in as octocat.');
    expect(gate.detail).toContain('Scopes: repo.');
  });

  it('logs raw diagnostics server-side and returns a sanitized auth_error gate when service auth check throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      return;
    });

    const { loadGitHubAuthGate, checkGitHubAuth } = await loadModuleWithAuthCheck(async () => {
      throw new Error('db connection failed: details should stay server-side');
    });

    const gate = await loadGitHubAuthGate();

    expect(checkGitHubAuth).toHaveBeenCalledTimes(1);
    expect(gate.state).toBe('auth_error');
    expect(gate.canMutate).toBe(false);
    expect(gate.detail).toBe('Unable to verify GitHub authentication right now.');
    expect(gate.detail).not.toContain('db connection failed');
    expect(gate.needsRemediation).toBe(true);
    expect(gate.remediationCommands).toContain('gh auth login');
    expect(consoleError).toHaveBeenCalledWith(
      'Dashboard GitHub auth gate check failed.',
      expect.objectContaining({
        message: 'db connection failed: details should stay server-side',
        name: 'Error',
      }),
    );
  });
});
