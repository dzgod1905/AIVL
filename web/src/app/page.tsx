"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Workflow = { id: string; name: string; createdAt: string };

export default function Home() {
  const router = useRouter();
  const [wfs, setWfs] = useState<Workflow[]>([]);
  const [err, setErr] = useState("");

  function load() {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setWfs(d) : setErr(d.error ?? "load failed")))
      .catch(() => setErr("Failed to load workflows (is the DB configured?)"));
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id: string, name: string) {
    if (!confirm(`Delete workflow "${name}"? This also removes its run history.`)) {
      return;
    }
    const r = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (r.ok) setWfs((prev) => prev.filter((w) => w.id !== id));
    else setErr("Delete failed");
  }

  return (
    <div>
      <h1>Workflow Builder + Multi-Agent (PoC)</h1>
      <p className="muted">
        Each step is an AI agent or a parser tool. The orchestrator runs
        independent branches in parallel and supports human-in-the-loop pauses.
      </p>
      <div className="row">
        <a href="/builder"><button>+ New workflow (Builder)</button></a>
      </div>

      {err && <p style={{ color: "var(--err)" }}>{err}</p>}

      <div className="card">
        <h2>Saved workflows</h2>
        {wfs.length === 0 && <p className="muted">No workflows yet. Build one.</p>}
        {wfs.map((w) => (
          <div
            className="step-card"
            key={w.id}
            style={{ cursor: "pointer" }}
            onClick={() => router.push(`/workflow/${w.id}`)}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <b>{w.name}</b>
                <div className="muted">{w.id}</div>
              </div>
              <div className="row">
                <button onClick={(e) => { e.stopPropagation(); router.push(`/workflow/${w.id}`); }}>
                  Sessions
                </button>
                <button
                  className="secondary"
                  onClick={(e) => { e.stopPropagation(); router.push(`/builder?id=${w.id}`); }}
                >
                  Edit
                </button>
                <button
                  className="danger"
                  onClick={(e) => { e.stopPropagation(); remove(w.id, w.name); }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
