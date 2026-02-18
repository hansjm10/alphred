'use client';

import { useEffect } from 'react';
import { ActionButton, Card } from '../../../ui/primitives';

type RunWorktreeErrorProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function RunWorktreeError({ error, reset }: RunWorktreeErrorProps) {
  useEffect(() => {
    console.error('Run worktree route error:', error);
  }, [error]);

  return (
    <div className="page-stack">
      <Card title="Worktree unavailable" role="alert" aria-live="assertive">
        <p>Unable to load worktree files for this run.</p>
        <div className="action-row">
          <ActionButton onClick={reset}>Retry</ActionButton>
        </div>
      </Card>
    </div>
  );
}

