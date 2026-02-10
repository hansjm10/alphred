'use client';

import { useEffect } from 'react';

type ErrorPageProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function DashboardError({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="app">
      <main>
        <section className="status-panel state-panel" role="alert" aria-live="assertive">
          <h2>Dashboard error</h2>
          <p>Something went wrong while loading this route.</p>
          <button className="state-action" type="button" onClick={reset}>
            Try again
          </button>
        </section>
      </main>
    </div>
  );
}
