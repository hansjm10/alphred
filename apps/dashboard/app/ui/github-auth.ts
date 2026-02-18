import type { DashboardGitHubAuthStatus } from '../../src/server/dashboard-contracts';
import type { StatusVariant } from './primitives';

export type GitHubAuthState = 'checking' | 'authenticated' | 'unauthenticated' | 'auth_error';

type AuthBadge = Readonly<{
  status: StatusVariant;
  label: string;
}>;

export type GitHubAuthGate = Readonly<{
  state: GitHubAuthState;
  badge: AuthBadge;
  canMutate: boolean;
  detail: string;
  user: string | null;
  scopes: readonly string[];
  checkedAtLabel: string;
  remediationCommands: readonly string[];
  needsRemediation: boolean;
}>;

const AUTH_REMEDIATION_COMMANDS = [
  'gh auth login',
  'export ALPHRED_GH_TOKEN="<github_token>"',
] as const;

const DEFAULT_UNAUTHENTICATED_MESSAGE = 'GitHub authentication is not configured for this runtime.';
const DEFAULT_AUTH_ERROR_MESSAGE = 'Unable to verify GitHub authentication right now.';
const CHECKING_MESSAGE = 'Checking GitHub authentication status.';

function formatCheckedAt(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function createCheckingGitHubAuthGate(checkedAt: Date = new Date()): GitHubAuthGate {
  return {
    state: 'checking',
    badge: {
      status: 'pending',
      label: 'Checking',
    },
    canMutate: false,
    detail: CHECKING_MESSAGE,
    user: null,
    scopes: [],
    checkedAtLabel: formatCheckedAt(checkedAt),
    remediationCommands: [],
    needsRemediation: false,
  };
}

export function createGitHubAuthErrorGate(message?: string, checkedAt: Date = new Date()): GitHubAuthGate {
  return {
    state: 'auth_error',
    badge: {
      status: 'failed',
      label: 'Auth check failed',
    },
    canMutate: false,
    detail: message?.trim() || DEFAULT_AUTH_ERROR_MESSAGE,
    user: null,
    scopes: [],
    checkedAtLabel: formatCheckedAt(checkedAt),
    remediationCommands: AUTH_REMEDIATION_COMMANDS,
    needsRemediation: true,
  };
}

export function createGitHubAuthGate(
  auth: DashboardGitHubAuthStatus,
  checkedAt: Date = new Date(),
): GitHubAuthGate {
  if (auth.authenticated) {
    const identity = auth.user ? `Signed in as ${auth.user}.` : 'Authenticated session detected.';
    const scopeSummary =
      auth.scopes.length > 0 ? `Scopes: ${auth.scopes.join(', ')}.` : 'No scopes were reported by the provider.';

    return {
      state: 'authenticated',
      badge: {
        status: 'completed',
        label: 'Authenticated',
      },
      canMutate: true,
      detail: `${identity} ${scopeSummary}`,
      user: auth.user,
      scopes: auth.scopes,
      checkedAtLabel: formatCheckedAt(checkedAt),
      remediationCommands: [],
      needsRemediation: false,
    };
  }

  return {
    state: 'unauthenticated',
    badge: {
      status: 'failed',
      label: 'Unauthenticated',
    },
    canMutate: false,
    detail: auth.error?.trim() || DEFAULT_UNAUTHENTICATED_MESSAGE,
    user: auth.user,
    scopes: auth.scopes,
    checkedAtLabel: formatCheckedAt(checkedAt),
    remediationCommands: AUTH_REMEDIATION_COMMANDS,
    needsRemediation: true,
  };
}
