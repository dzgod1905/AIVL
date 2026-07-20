"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Session = {
  id: string;
  title: string;
  createdAt: string;
  runCount: number;
  lastStatus: string | null;
};

export default function WorkflowSessions({
  params,
}: {
  params: { id: string };
}) {
  const workflowId = params.id;
  const router = useRouter();
  const [wfName, setWfName] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/sessions?workflowId=${workflowId}`)
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setSessions(d) : setErr(d.error ?? "load failed")))
      .catch(() => setErr("Failed to load sessions"));
  }, [workflowId]);

  useEffect(() => {
    fetch(`/api/workflows/${workflowId}`)
      .then((r) => r.json())
      .then((d) => setWfName(d?.workflow?.name ?? workflowId))
      .catch(() => setWfName(workflowId));
    load();
  }, [workflowId, load]);

  async function newSession() {
    if (creating) return;
    setCreating(true);
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "create failed");
        setCreating(false);
        return;
      }
      router.push(`/session/${d.id}`);
    } catch {
      setErr("network error creating session");
      setCreating(false);
    }
  }

  async function remove(id: string, title: string) {
    if (!confirm(`Delete "${title}"? This removes its run history.`)) return;
    const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (r.ok) setSessions((prev) => prev.filter((s) => s.id !== id));
    else setErr("Delete failed");
  }

  return (
    <div>
      <h1>{wfName || "Workflow"}</h1>
      <p className="muted">
        Each session is an independent chat thread. Open several in parallel to
        run the same workflow on different inputs at once.
      </p>
      <div className="row">
        <button onClick={newSession} disabled={creating}>
          {creating ? "Creating..." : "+ New session"}
        </button>
        <a href={`/builder?id=${workflowId}`}>
          <button className="secondary">Edit workflow</button>
        </a>
      </div>

      {err && <p style={{ color: "var(--err)" }}>{err}</p>}

      <div className="card">
        <h2>Sessions</h2>
        {sessions.length === 0 && (
          <p className="muted">No sessions yet. Create one to start.</p>
        )}
        {sessions.map((s) => (
          <div
            className="step-card"
            key={s.id}
            style={{ cursor: "pointer" }}
            onClick={() => router.push(`/session/${s.id}`)}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <b>{s.title}</b>
                <div className="muted">
                  {s.runCount} run{s.runCount === 1 ? "" : "s"}
                  {s.lastStatus ? ` · last: ${s.lastStatus}` : ""}
                </div>
              </div>
              <div className="row">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/session/${s.id}`);
                  }}
                >
                  Open
                </button>
                <button
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s.id, s.title);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <a href="/" className="muted">← All workflows</a>
    </div>
  );
}
