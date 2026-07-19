"use client";

import { useEffect, useRef, useState } from "react";

type StepView = {
  stepKey: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  done: boolean;
  attempts: number;
  fail_reason: string | null;
};
type RunView = { status: string; steps: StepView[] };

export default function RunPage({ params }: { params: { id: string } }) {
  const runId = params.id;
  const [run, setRun] = useState<RunView | null>(null);
  const [runStatus, setRunStatus] = useState<string>("running");
  const [log, setLog] = useState<string[]>([]);
  const [pausedStep, setPausedStep] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  async function refresh() {
    const r = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
    if (r.ok) {
      const data = (await r.json()) as RunView;
      setRun(data);
      setRunStatus(data.status);
      if (data.status !== "paused_for_human") setPausedStep(null);
    }
  }

  useEffect(() => {
    refresh();
    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data);
        setLog((l) => [`${new Date().toLocaleTimeString()} ${ev.data}`, ...l].slice(0, 200));
        if (e.type === "run_status") {
          setRunStatus(e.status);
          if (e.status === "paused_for_human") setPausedStep(e.pausedStep ?? null);
          if (e.status === "done" || e.status === "failed") es.close();
        }
        // any update -> refresh detailed step IO from service
        refresh();
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function resume() {
    setResuming(true);
    try {
      await fetch(`/api/runs/${runId}/resume`, { method: "POST" });
      await refresh();
    } finally {
      setResuming(false);
    }
  }

  const pausedStepView = run?.steps.find((s) => s.stepKey === pausedStep) ?? null;

  return (
    <div>
      <h1>
        Run <span className="tag">{runId.slice(0, 8)}</span>{" "}
        <span className={`badge ${runStatus}`}>{runStatus}</span>
      </h1>

      {runStatus === "paused_for_human" && (
        <div className="card" style={{ borderColor: "var(--warn)" }}>
          <h2>Human review needed</h2>
          <p className="muted">Step <b>{pausedStep}</b> finished. Review input/output, then continue.</p>
          {pausedStepView && (
            <div className="grid2">
              <div>
                <label>Input</label>
                <pre>{JSON.stringify(pausedStepView.input, null, 2)}</pre>
              </div>
              <div>
                <label>Output</label>
                <pre>{JSON.stringify(pausedStepView.output, null, 2)}</pre>
              </div>
            </div>
          )}
          <button onClick={resume} disabled={resuming}>Continue</button>
        </div>
      )}

      <div className="card">
        <h2>Steps</h2>
        {(run?.steps ?? []).map((s) => (
          <div className="step-card" key={s.stepKey}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>
                {s.stepKey}
                <span className="tag">attempts: {s.attempts}</span>
                {s.fail_reason && <span className="tag">{s.fail_reason}</span>}
              </h3>
              <span className={`badge ${s.status}`}>{s.status}</span>
            </div>
            <div className="grid2">
              <div>
                <label>Input</label>
                <pre>{JSON.stringify(s.input, null, 2)}</pre>
              </div>
              <div>
                <label>Output</label>
                <pre>{JSON.stringify(s.output, null, 2)}</pre>
              </div>
            </div>
          </div>
        ))}
        {(!run || run.steps.length === 0) && <p className="muted">Waiting for steps...</p>}
      </div>

      <div className="card">
        <h2>Event log (SSE)</h2>
        <pre style={{ maxHeight: 260 }}>{log.join("\n")}</pre>
      </div>
    </div>
  );
}
