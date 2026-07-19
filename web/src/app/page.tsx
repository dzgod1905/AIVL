export default function Home() {
  return (
    <div>
      <h1>Workflow Builder + Multi-Agent (PoC)</h1>
      <p className="muted">
        Build multi-step workflows where each step is an AI agent or an automation
        tool. The orchestrator runs independent branches in parallel and supports
        human-in-the-loop pauses.
      </p>
      <div className="card">
        <h2>Start</h2>
        <p><a href="/builder">→ Open the Builder</a></p>
        <p className="muted">
          Run a workflow, then watch it live on <code>/runs/[id]</code> via SSE.
        </p>
      </div>
    </div>
  );
}
