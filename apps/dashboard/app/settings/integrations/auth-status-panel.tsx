'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthRemediation } from '../../ui/auth-remediation';
import { createCheckingGitHubAuthGate, type GitHubAuthGate } from '../../ui/github-auth';
import { ActionButton, ButtonLink, StatusBadge } from '../../ui/primitives';

type AuthStatusPanelProps = Readonly<{
  authGate: GitHubAuthGate;
}>;

export function AuthStatusPanel({ authGate }: AuthStatusPanelProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const router = useRouter();
  const visibleAuthGate = isChecking ? createCheckingGitHubAuthGate() : authGate;

  async function handleCheckAuth(): Promise<void> {
    if (isChecking) {
      return;
    }

    setCheckError(null);
    setIsChecking(true);

    try {
      const response = await fetch('/api/dashboard/auth/github/check', {
        method: 'POST',
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`GitHub auth check failed with status ${response.status}.`);
      }

      router.refresh();
    } catch {
      setCheckError('Unable to refresh GitHub authentication status. Try again.');
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <>
      <ul className="entity-list">
        <li>
          <span>Current state</span>
          <StatusBadge status={visibleAuthGate.badge.status} label={visibleAuthGate.badge.label} />
        </li>
        <li>
          <span>Last checked</span>
          <span className="meta-text">{visibleAuthGate.checkedAtLabel}</span>
        </li>
        {visibleAuthGate.user ? (
          <li>
            <span>Identity</span>
            <span className="meta-text">{visibleAuthGate.user}</span>
          </li>
        ) : null}
        {visibleAuthGate.scopes.length > 0 ? (
          <li>
            <span>Scopes</span>
            <span className="meta-text">{visibleAuthGate.scopes.join(', ')}</span>
          </li>
        ) : null}
      </ul>
      <p className="meta-text">{visibleAuthGate.detail}</p>
      {checkError ? (
        <p className="meta-text" role="status" aria-live="polite">
          {checkError}
        </p>
      ) : null}

      <div className="action-row">
        <ActionButton
          tone="primary"
          disabled={isChecking}
          aria-disabled={isChecking}
          onClick={() => {
            void handleCheckAuth();
          }}
        >
          {isChecking ? 'Checking auth...' : 'Check Auth'}
        </ActionButton>
        <ButtonLink href="/repositories">Back to Repositories</ButtonLink>
        <ButtonLink href="/runs">Back to Runs</ButtonLink>
      </div>
      <AuthRemediation
        authGate={visibleAuthGate}
        context="Repository sync and run launch are gated until GitHub auth is restored."
      />
    </>
  );
}
