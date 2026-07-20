"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Step = {
  stepKey: string;
  status: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  done: boolean;
  attempts: number;
  fail_reason: string | null;
};
type RunView = { status: string; steps: Step[] };

// Lightweight step shape from the workflow definition, for the DAG.
type DagStep = {
  stepKey: string;
  unitId: string;
  unitType: string;
  humanInvolved: boolean;
  dependsOn: string[];
};

type Msg =
  | { id: number; role: "user"; text: string; file?: string }
  | { id: number; role: "status"; text: string }
  | { id: number; role: "assistant"; steps: Step[]; status: string };

// distribute Omit over the union so excess-property checks stay per-variant
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type MsgInput = DistOmit<Msg, "id">;

export default function SessionPage({ params }: { params: { id: string } }) {
  const sessionId = params.id;
  const [workflowId, setWorkflowId] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [wfName, setWfName] = useState<string>("");
  const [dagSteps, setDagSteps] = useState<DagStep[]>([]);
  const [stepStatus, setStepStatus] = useState<Record<string, string>>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [pausedStep, setPausedStep] = useState<string | null>(null);
  const [stepOutputs, setStepOutputs] = useState<Record<string, unknown>>({});

  const esRef = useRef<EventSource | null>(null);
  const idRef = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load session meta, workflow steps (for the DAG), and past-run history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetch(`/api/sessions/${sessionId}`, { cache: "no-store" }).then((r) => r.json());
        if (cancelled || !s?.session) return;
        const wfId = s.session.workflowId as string;
        setWorkflowId(wfId);
        setTitle(s.session.title ?? "Session");
        setWfName(s.workflowName ?? wfId);

        const wf = await fetch(`/api/workflows/${wfId}`, { cache: "no-store" }).then((r) => r.json());
        if (!cancelled && Array.isArray(wf?.steps)) {
          setDagSteps(
            wf.steps.map((st: Record<string, unknown>) => ({
              stepKey: String(st.stepKey),
              unitId: String(st.unitId),
              unitType: String(st.unitType),
              humanInvolved: Boolean(st.humanInvolved),
              dependsOn: Array.isArray(st.dependsOn) ? (st.dependsOn as string[]) : [],
            })),
          );
        }

        await reconstruct(cancelled);
      } catch {
        /* ignore load errors */
      }
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    // autoscroll to newest message
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [msgs]);

  // Rebuild the chat from this session's persisted runs. For each run, show the
  // user input, then fetch its step detail from the orchestrator. If a run is
  // still running, reattach its live stream.
  async function reconstruct(cancelled: boolean) {
    const runs: {
      orchestratorRunId: string;
      input: Record<string, unknown> | null;
      status: string;
    }[] = await fetch(`/api/sessions/${sessionId}/runs`, { cache: "no-store" }).then((r) => r.json());
    if (cancelled || !Array.isArray(runs)) return;

    let lastStatus: Record<string, string> = {};
    for (const run of runs) {
      const inp = run.input ?? {};
      const req = typeof inp.request === "string" ? inp.request : "(no text)";
      const f = typeof inp.file === "string" ? inp.file : undefined;
      push({ role: "user", text: req || "(no text)", file: f });

      // The web DB's workflow_runs.status is only ever "running" (never updated
      // after the run ends). The orchestrator is the source of truth, so read the
      // live status from GET /runs/{id} and branch on THAT, not run.status.
      let data: RunView;
      try {
        data = (await fetch(`/api/runs/${run.orchestratorRunId}`, { cache: "no-store" }).then((r) =>
          r.json(),
        )) as RunView;
      } catch {
        pushStatus(`failed to load run ${run.orchestratorRunId}`);
        continue;
      }

      lastStatus = {};
      for (const st of data.steps ?? []) lastStatus[st.stepKey] = st.status;

      if (data.status === "running" || data.status === "paused_for_human") {
        setRunning(true);
        setRunId(run.orchestratorRunId);
        if (data.status === "paused_for_human") {
          // steps run strictly in order, so the pause point is the last done step
          const done = (data.steps ?? []).filter((s) => s.status === "done");
          const last = done[done.length - 1];
          if (last) {
            setPausedStep(last.stepKey);
            if (last.output != null) {
              setStepOutputs((m) => ({ ...m, [last.stepKey]: last.output }));
            }
          }
          pushStatus("resuming (paused for human review)");
        } else {
          pushStatus("resuming live run");
        }
        startSSE(run.orchestratorRunId);
      } else {
        push({ role: "assistant", steps: data.steps ?? [], status: data.status });
      }
    }
    if (!cancelled && Object.keys(lastStatus).length) setStepStatus(lastStatus);
  }

  function push(m: MsgInput) {
    setMsgs((prev) => [...prev, { ...m, id: ++idRef.current } as Msg]);
  }
  function pushStatus(t: string) {
    push({ role: "status", text: t });
  }

  function startSSE(id: string) {
    esRef.current?.close();
    const es = new EventSource(`/api/runs/${id}/events`);
    esRef.current = es;
    es.onmessage = (ev) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      const type = e.type as string;
      if (type === "snapshot") {
        // Baseline sent on (re)subscribe. Essential when reattaching to a run
        // that already finished while this page was unmounted: the terminal
        // run_status event fired before we subscribed, so the snapshot is the
        // only signal it is done.
        const snapSteps = e.steps as Record<string, string> | undefined;
        if (snapSteps) setStepStatus((m) => ({ ...m, ...snapSteps }));
        const snapStatus = e.status as string;
        if (snapStatus === "done" || snapStatus === "failed") {
          es.close();
          finalize(id, snapStatus);
        }
        return;
      }
      if (type === "step_status") {
        const k = e.stepKey as string;
        const st = e.status as string;
        setStepStatus((m) => ({ ...m, [k]: st }));
        const fr = e.fail_reason ? ` (${e.fail_reason})` : "";
        pushStatus(`${k} -> ${st}${fr}`);
        if (st === "done" && e.output !== undefined) {
          setStepOutputs((m) => ({ ...m, [k]: e.output }));
        }
      } else if (type === "step_reask") {
        setStepStatus((m) => ({ ...m, [e.stepKey as string]: "running" }));
        pushStatus(`${e.stepKey} -> re-ask (attempt ${e.attempt})`);
      } else if (type === "run_status") {
        const status = e.status as string;
        if (status === "paused_for_human") {
          const ps = (e.pausedStep as string) ?? null;
          setPausedStep(ps);
          if (ps) setStepStatus((m) => ({ ...m, [ps]: "paused_for_human" }));
          pushStatus(`paused for human review: ${e.pausedStep}`);
        } else if (status === "running") {
          setPausedStep(null);
        } else if (status === "done" || status === "failed") {
          es.close();
          finalize(id, status);
        }
      }
    };
    es.onerror = () => { /* browser auto-reconnects */ };
  }

  async function finalize(id: string, status: string) {
    try {
      const r = await fetch(`/api/runs/${id}`, { cache: "no-store" });
      const data = (await r.json()) as RunView;
      push({ role: "assistant", steps: data.steps ?? [], status });
      const fin: Record<string, string> = {};
      for (const st of data.steps ?? []) fin[st.stepKey] = st.status;
      setStepStatus(fin);
    } catch {
      pushStatus("failed to load final result");
    } finally {
      setRunning(false);
      setRunId(null);
      setPausedStep(null);
    }
  }

  async function send() {
    if (running) return;
    const t = text.trim();
    if (!t && !file) return;

    push({ role: "user", text: t || "(no text)", file: file?.name });
    const input: Record<string, unknown> = { request: t };
    if (file) {
      input.file = file.name;
      input.fileSize = file.size;
      try {
        input.file_b64 = await readB64(file); // real bytes for excel_reader
      } catch {
        pushStatus("failed to read attached file");
        setRunning(false);
        return;
      }
    }
    setText("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setStepOutputs({});
    setStepStatus({});
    setRunning(true);

    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId, sessionId, input }),
      });
      const d = await r.json();
      if (!r.ok) {
        pushStatus(`run failed: ${d.error ?? r.status} ${d.detail ?? ""}`);
        setRunning(false);
        return;
      }
      setRunId(d.runId);
      pushStatus("workflow started");
      startSSE(d.runId);
    } catch {
      pushStatus("network error starting run");
      setRunning(false);
    }
  }

  async function resume() {
    if (!runId) return;
    pushStatus("continue -> resuming");
    setPausedStep(null);
    await fetch(`/api/runs/${runId}/resume`, { method: "POST" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div>
      <h1>
        {title || "Session"}{" "}
        {wfName && <span className="muted" style={{ fontSize: 13 }}>({wfName})</span>}{" "}
        {running && <span className="badge running">running</span>}
        {pausedStep && <span className="badge paused_for_human">paused</span>}
      </h1>
      <p className="muted">
        Type a message and/or attach a file, then press Enter to start the
        workflow. Steps stream in below and light up in the diagram on the right.
      </p>

      <div className="session-grid">
        <div className="card">
          <div className="chat" ref={chatRef}>
            {msgs.length === 0 && (
              <p className="muted">No messages yet. Send one to start.</p>
            )}
            {msgs.map((m) => {
              if (m.role === "user") {
                return (
                  <div className="bubble user" key={m.id}>
                    {m.text}
                    {m.file && <div className="filechip">file: {m.file}</div>}
                  </div>
                );
              }
              if (m.role === "status") {
                return (
                  <div className="bubble status" key={m.id}>{m.text}</div>
                );
              }
              return <AssistantMsg key={m.id} steps={m.steps} status={m.status} />;
            })}
          </div>

          {pausedStep && runId && (
            <div className="card" style={{ borderColor: "var(--warn)", marginTop: 10 }}>
              <p className="muted" style={{ margin: "0 0 8px" }}>
                Step <b>{pausedStep}</b> finished and needs human review.
              </p>
              {stepOutputs[pausedStep] !== undefined && (
                <>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="muted">Output JSON</span>
                    <button
                      className="secondary"
                      onClick={() => downloadJson(pausedStep, stepOutputs[pausedStep])}
                    >
                      Download JSON
                    </button>
                  </div>
                  <pre style={{ maxHeight: 260 }}>
                    {JSON.stringify(stepOutputs[pausedStep], null, 2)}
                  </pre>
                </>
              )}
              <button onClick={resume}>Continue</button>
            </div>
          )}

          <div className="composer">
            <div style={{ flex: 1 }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={running ? "Workflow running..." : "Message (Enter to send, Shift+Enter for newline)"}
                disabled={running}
              />
              {file && <div className="filechip">attached: {file.name}</div>}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button
              className="secondary"
              disabled={running}
              onClick={() => fileInputRef.current?.click()}
            >
              Attach
            </button>
            <button onClick={send} disabled={running || (!text.trim() && !file)}>
              Send
            </button>
          </div>
        </div>

        <div>
          <RunDag steps={dagSteps} status={stepStatus} running={running} />
          <AgentPanel running={running} />
        </div>
      </div>

      <div className="row">
        <a href={workflowId ? `/workflow/${workflowId}` : "/"} className="muted">
          ← Sessions
        </a>
        {workflowId && (
          <a
            href={`/workflow/${workflowId}`}
            className="muted"
            title="Open the session list to start another parallel session"
          >
            + New parallel session
          </a>
        )}
      </div>
    </div>
  );
}

// download any JSON-serializable value as <name>.json
function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// read a File as base64 (strip the data: URL prefix)
function readB64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

const STATUS_COLOR: Record<string, string> = {
  done: "var(--ok)",
  running: "var(--accent)",
  failed: "var(--err)",
  paused_for_human: "var(--warn)",
};

// intersection of a ray from a node center with the node's rect border (+gap)
function borderPoint(
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  halfW: number,
  halfH: number,
  gap: number,
): [number, number] {
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty) + gap;
  return [cx + dx * t, cy + dy * t];
}

// Live DAG for a run: nodes in a vertical chain (run order), colored by status.
// Dashed accent edges mark variable references to non-adjacent prior steps.
function RunDag({
  steps,
  status,
  running,
}: {
  steps: DagStep[];
  status: Record<string, string>;
  running: boolean;
}) {
  const NW = 190, NH = 48, VGAP = 34, PAD = 14;

  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    steps.forEach((s, i) => {
      pos.set(s.stepKey, { x: PAD, y: PAD + i * (NH + VGAP) });
    });
    const width = PAD * 2 + NW;
    const height = PAD * 2 + Math.max(1, steps.length) * (NH + VGAP) - VGAP;
    return { pos, width, height };
  }, [steps]);

  const { pos, width, height } = layout;

  return (
    <div className="card dag-panel">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Diagram</h2>
        <span className="muted">{running ? "live" : "run order"}</span>
      </div>
      {steps.length === 0 ? (
        <p className="muted">No steps.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <svg width={width} height={height} style={{ display: "block", maxWidth: "none" }}>
            <defs>
              <marker id="rdag-arrow" viewBox="0 0 10 10" refX={9} refY={5}
                markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
              </marker>
              <marker id="rdag-ref" viewBox="0 0 10 10" refX={9} refY={5}
                markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
              </marker>
            </defs>
            {/* solid chain edges: step i -> i+1 (run order) */}
            {steps.slice(0, -1).map((s, i) => {
              const next = steps[i + 1];
              const a = pos.get(s.stepKey);
              const b = pos.get(next.stepKey);
              if (!a || !b) return null;
              const acx = a.x + NW / 2, acy = a.y + NH / 2;
              const bcx = b.x + NW / 2, bcy = b.y + NH / 2;
              let dx = bcx - acx, dy = bcy - acy;
              const len = Math.hypot(dx, dy) || 1;
              dx /= len; dy /= len;
              const [sx, sy] = borderPoint(acx, acy, dx, dy, NW / 2, NH / 2, 0);
              const [ex, ey] = borderPoint(bcx, bcy, -dx, -dy, NW / 2, NH / 2, 4);
              return (
                <path key={`${s.stepKey}->${next.stepKey}`} d={`M ${sx} ${sy} L ${ex} ${ey}`}
                  fill="none" stroke="var(--muted)" strokeWidth={1.25} markerEnd="url(#rdag-arrow)" />
              );
            })}
            {/* dashed edges: variable refs to non-adjacent prior steps */}
            {steps.flatMap((s, i) =>
              (s.dependsOn ?? []).map((dep) => {
                const j = steps.findIndex((x) => x.stepKey === dep);
                if (j < 0 || j === i - 1) return null;
                const a = pos.get(dep);
                const b = pos.get(s.stepKey);
                if (!a || !b) return null;
                const acx = a.x + NW / 2, acy = a.y + NH / 2;
                const bcx = b.x + NW / 2, bcy = b.y + NH / 2;
                let dx = bcx - acx, dy = bcy - acy;
                const len = Math.hypot(dx, dy) || 1;
                dx /= len; dy /= len;
                const [sx, sy] = borderPoint(acx, acy, dx, dy, NW / 2, NH / 2, 0);
                const [ex, ey] = borderPoint(bcx, bcy, -dx, -dy, NW / 2, NH / 2, 4);
                return (
                  <path key={`ref-${dep}->${s.stepKey}`} d={`M ${sx} ${sy} L ${ex} ${ey}`}
                    fill="none" stroke="var(--accent)" strokeWidth={1.25}
                    strokeDasharray="4 3" markerEnd="url(#rdag-ref)" />
                );
              }),
            )}
            {/* nodes colored by live status */}
            {steps.map((s) => {
              const p = pos.get(s.stepKey);
              if (!p) return null;
              const st = status[s.stepKey] ?? "pending";
              const color = STATUS_COLOR[st] ?? "var(--border)";
              const active = st === "running";
              return (
                <g key={s.stepKey} transform={`translate(${p.x}, ${p.y})`}>
                  <rect width={NW} height={NH} rx={8} fill="var(--panel2)"
                    stroke={color} strokeWidth={active ? 2 : 1}>
                    {active && (
                      <animate attributeName="opacity" values="1;0.55;1" dur="1.2s" repeatCount="indefinite" />
                    )}
                  </rect>
                  <text x={12} y={20} fill="var(--text)" fontSize={13} fontWeight={600}>
                    {s.stepKey.length > 22 ? s.stepKey.slice(0, 21) + "…" : s.stepKey}
                  </text>
                  <text x={12} y={38} fill="var(--muted)" fontSize={11}>
                    {st}{s.humanInvolved ? " · human" : ""}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        <span className="badge pending">pending</span>
        <span className="badge running">running</span>
        <span className="badge done">done</span>
        <span className="badge failed">failed</span>
      </div>
    </div>
  );
}

type AgentStat = { agent: string; inflight: number; state: "busy" | "idle" };

// Live worker/agent busy-idle snapshot, proxied from the orchestrator's
// GET /agents. Polls while a run is active; one static read otherwise.
function AgentPanel({ running }: { running: boolean }) {
  const [agents, setAgents] = useState<AgentStat[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const r = await fetch("/api/agents", { cache: "no-store" });
        const data = (await r.json()) as AgentStat[];
        if (!cancelled && Array.isArray(data)) setAgents(data);
      } catch {
        /* orchestrator unreachable -> leave last snapshot */
      }
    }
    pull();
    if (!running) return () => { cancelled = true; };
    const t = setInterval(pull, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [running]);

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Agents</h2>
        <span className="muted">{running ? "live" : "idle"}</span>
      </div>
      {agents.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No agent data - is the orchestrator running?
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {agents.map((a) => (
            <div className="row" key={a.agent} style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13 }}>{a.agent}</span>
              <span className="row" style={{ gap: 6 }}>
                {a.inflight > 0 && <span className="tag">{a.inflight} in-flight</span>}
                <span className={`badge ${a.state === "busy" ? "running" : "pending"}`}>
                  {a.state}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantMsg({ steps, status }: { steps: Step[]; status: string }) {
  return (
    <div className="bubble assistant" style={{ maxWidth: "92%" }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <b>Result</b>
        <span className={`badge ${status}`}>{status}</span>
      </div>
      {steps.map((s) => {
        const out = s.output as Record<string, unknown> | null;
        const text = out && typeof out.text === "string" ? out.text : null;
        const totalRows = out && typeof out.total_rows === "number" ? out.total_rows : null;
        const sheetCount = out && Array.isArray(out.sheets) ? (out.sheets as unknown[]).length : null;
        const err = out && typeof out.error === "string" ? out.error : null;
        const src = out && typeof out.source === "string" ? out.source : null;
        return (
          <div className="step-card" key={s.stepKey} style={{ marginBottom: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <b>{s.stepKey}</b>
                <span className="tag">attempts: {s.attempts}</span>
                {s.fail_reason && <span className="tag">{s.fail_reason}</span>}
              </span>
              <span className={`badge ${s.status}`}>{s.status}</span>
            </div>
            {text && <div style={{ marginTop: 6 }}>{text}</div>}
            {err && (
              <div style={{ marginTop: 6, color: "var(--err)" }}>{err}</div>
            )}
            {totalRows !== null && !err && (
              <div className="muted" style={{ marginTop: 6 }}>
                parsed {totalRows} rows across {sheetCount} sheet
                {sheetCount === 1 ? "" : "s"}
                {src === "sample" ? " (sample - no file uploaded)" : ""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
