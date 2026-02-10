export function App() {
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
        </section>
      </main>
    </div>
  );
}
