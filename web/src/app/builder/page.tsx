"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogUnit, StepDef } from "@/lib/types";

function slugKey(name: string, existing: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  let key = base || "step";
  let i = 2;
  while (existing.includes(key)) key = `${base}_${i++}`;
  return key;
}

export default function BuilderPage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogUnit[]>([]);
  const [name, setName] = useState("My workflow");
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/catalog")
      .then((r) => r.json())
      .then(setCatalog)
      .catch(() => setMsg("Failed to load catalog - are the services running?"));
  }, []);

  const stepKeys = useMemo(() => steps.map((s) => s.stepKey), [steps]);

  function addUnit(u: CatalogUnit) {
    const stepKey = slugKey(u.id, stepKeys);
    const newStep: StepDef = {
      stepKey,
      unitId: u.id,
      unitType: u.type,
      source: u.source,
      promptTemplate: u.type === "ai_agent" ? "" : undefined,
      contextMapping: {},
      dependsOn: [],
      humanInvolved: false,
      maxAttempts: 5,
      timeoutSec: 30,
      config: {},
    };
    setSteps((s) => [...s, newStep]);
    setPicking(false);
  }

  function update(idx: number, patch: Partial<StepDef>) {
    setSteps((s) => s.map((st, i) => (i === idx ? { ...st, ...patch } : st)));
  }

  function remove(idx: number) {
    setSteps((s) => s.filter((_, i) => i !== idx));
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, steps }),
      });
      const data = await r.json();
      if (!r.ok) {
        setMsg(`Save failed: ${data.error ?? r.status}`);
        return null;
      }
      setMsg(`Saved workflow ${data.id}`);
      return data.id as string;
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    const id = await save();
    if (!id) return;
    setBusy(true);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: id, input: { request: "demo" } }),
      });
      const data = await r.json();
      if (!r.ok) {
        setMsg(`Run failed: ${data.error ?? r.status}`);
        return;
      }
      router.push(`/runs/${data.runId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Builder</h1>
      <div className="card">
        <label>Workflow name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      {steps.map((s, idx) => (
        <StepEditor
          key={s.stepKey}
          step={s}
          idx={idx}
          priorKeys={stepKeys.slice(0, idx)}
          otherKeys={stepKeys.filter((k) => k !== s.stepKey)}
          onChange={(patch) => update(idx, patch)}
          onRemove={() => remove(idx)}
        />
      ))}

      <div className="card">
        {!picking ? (
          <button className="secondary" onClick={() => setPicking(true)}>
            + Add step
          </button>
        ) : (
          <UnitPicker catalog={catalog} onPick={addUnit} onCancel={() => setPicking(false)} />
        )}
      </div>

      <div className="row">
        <button onClick={run} disabled={busy || steps.length === 0}>
          Run
        </button>
        <button className="secondary" onClick={save} disabled={busy || steps.length === 0}>
          Save only
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  );
}

function UnitPicker({
  catalog,
  onPick,
  onCancel,
}: {
  catalog: CatalogUnit[];
  onPick: (u: CatalogUnit) => void;
  onCancel: () => void;
}) {
  const ai = catalog.filter((u) => u.source === "ai");
  const automation = catalog.filter((u) => u.source === "automation");
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Pick a unit</h3>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
      <p className="muted">AI agents</p>
      <div className="row">
        {ai.map((u) => (
          <button key={u.id} className="secondary" onClick={() => onPick(u)}>
            {u.name} <span className="tag">ai</span>
          </button>
        ))}
      </div>
      <p className="muted">Automation tools</p>
      <div className="row">
        {automation.map((u) => (
          <button key={u.id} className="secondary" onClick={() => onPick(u)}>
            {u.name} <span className="tag">automation</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepEditor({
  step,
  idx,
  priorKeys,
  otherKeys,
  onChange,
  onRemove,
}: {
  step: StepDef;
  idx: number;
  priorKeys: string[];
  otherKeys: string[];
  onChange: (patch: Partial<StepDef>) => void;
  onRemove: () => void;
}) {
  function toggleDep(k: string) {
    const has = step.dependsOn.includes(k);
    onChange({
      dependsOn: has ? step.dependsOn.filter((d) => d !== k) : [...step.dependsOn, k],
    });
  }

  function insertRef(ref: string) {
    onChange({ promptTemplate: (step.promptTemplate ?? "") + `{{${ref}}}` });
  }

  const configStr = JSON.stringify(step.config ?? {});

  return (
    <div className="step-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>
          #{idx + 1} {step.stepKey}
          <span className="tag">{step.unitType}</span>
          <span className="tag">{step.unitId}</span>
        </h3>
        <button className="danger" onClick={onRemove}>Remove</button>
      </div>

      <label>Step key</label>
      <input
        value={step.stepKey}
        onChange={(e) => onChange({ stepKey: e.target.value })}
      />

      {step.unitType === "ai_agent" && (
        <>
          <label>Prompt template (reference prior outputs)</label>
          {priorKeys.length > 0 && (
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="muted">Insert:</span>
              {priorKeys.map((k) => (
                <button
                  key={k}
                  className="secondary"
                  onClick={() => insertRef(`${k}.output`)}
                >
                  {`{{${k}.output}}`}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={step.promptTemplate ?? ""}
            onChange={(e) => onChange({ promptTemplate: e.target.value })}
            placeholder="From {{parser.output}}, build a plan..."
          />
        </>
      )}

      <label>Depends on (defines parallel/branch order)</label>
      <div className="row">
        {otherKeys.length === 0 && <span className="muted">no other steps yet</span>}
        {otherKeys.map((k) => (
          <label key={k} className="row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={step.dependsOn.includes(k)}
              onChange={() => toggleDep(k)}
            />
            <span>{k}</span>
          </label>
        ))}
      </div>

      <div className="grid2">
        <div>
          <label>Max attempts</label>
          <input
            type="number"
            value={step.maxAttempts}
            onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })}
          />
        </div>
        <div>
          <label>Timeout (sec)</label>
          <input
            type="number"
            value={step.timeoutSec}
            onChange={(e) => onChange({ timeoutSec: Number(e.target.value) })}
          />
        </div>
      </div>

      <label className="row" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={step.humanInvolved}
          onChange={(e) => onChange({ humanInvolved: e.target.checked })}
        />
        <span>Human involved (pause after this step)</span>
      </label>

      <label>Agent config JSON (e.g. {`{"stuck": true}`} or {`{"simulate_incomplete": 2}`})</label>
      <input
        defaultValue={configStr}
        onBlur={(e) => {
          try {
            onChange({ config: JSON.parse(e.target.value || "{}") });
          } catch {
            /* ignore invalid json until valid */
          }
        }}
      />
    </div>
  );
}
