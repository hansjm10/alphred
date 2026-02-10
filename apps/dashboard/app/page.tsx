import Link from 'next/link';

export default function Page() {
  const showTestRoutes = process.env.ALPHRED_DASHBOARD_TEST_ROUTES === '1';

  return (
    <div className="app">
      <header>
        <h1>Alphred Dashboard</h1>
        <p>LLM Agent Orchestrator</p>
      </header>
      <main>
        <section className="status-panel">
          <h2>Workflow Runs</h2>
          <p>No active runs. Start a workflow from the CLI.</p>
          {showTestRoutes ? (
            <Link className="state-link" href="/test/slow" prefetch={false}>
              Open slow dashboard route
            </Link>
          ) : null}
        </section>
      </main>
    </div>
  );
}
