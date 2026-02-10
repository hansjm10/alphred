import Link from 'next/link';

export default function Page() {
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
          <Link className="state-link" href="/slow" prefetch={false}>
            Open slow dashboard route
          </Link>
        </section>
      </main>
    </div>
  );
}
