"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogUnit, StepDef } from "@/lib/types";

const CATEGORY_LABEL: Record<string, string> = {
  ai_agent: "AI Agent",
  parser: "Parser",
};

function categoryLabel(c: string): string {
  return CATEGORY_LABEL[c] ?? c;
}

function slugKey(name: string, existing: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  let key = base || "step";
  let i = 2;
  while (existing.includes(key)) key = `${base}_${i++}`;
  return key;
}

export default function BuilderPage() {
  const [catalog, setCatalog] = useState<CatalogUnit[]>([]);
  const [name, setName] = useState("My workflow");
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    fetch("/api/catalog")
      .then((r) => r.json())
      .then(setCatalog)
      .catch(() => setMsg("Failed to load catalog - is the orchestrator running?"));
    // ?id=<uuid> -> edit an existing workflow
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setEditId(id);
  }, []);

  // unitId -> category, from the catalog (category is not persisted in the DB)
  const catByUnit = useMemo(() => {
    const m: Record<string, string> = {};
    for (const u of catalog) m[u.id] = u.category;
    return m;
  }, [catalog]);

  // load an existing workflow once, after the catalog is available
  useEffect(() => {
    if (!editId || catalog.length === 0 || loadedRef.current) return;
    loadedRef.current = true;
    fetch(`/api/workflows/${editId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.workflow) {
          setMsg("Workflow not found");
          return;
        }
        setName(d.workflow.name);
        type Row = {
          stepKey: string; unitId: string; unitType: StepDef["unitType"];
          source: StepDef["source"]; promptTemplate: string | null;
          apiConfig: Record<string, unknown> | null; dependsOn: string[] | null;
          humanInvolved: boolean; maxAttempts: number; timeoutSec: number;
        };
        const loaded: StepDef[] = (d.steps as Row[]).map((s) => {
          const category = catByUnit[s.unitId] ?? "ai_agent";
          return {
            id: crypto.randomUUID(),
            stepKey: s.stepKey,
            unitId: s.unitId,
            unitType: s.unitType,
            source: s.source,
            category,
            promptTemplate: s.promptTemplate ?? (category === "ai_agent" ? "" : undefined),
            dependsOn: s.dependsOn ?? [],
            humanInvolved: s.humanInvolved,
            maxAttempts: s.maxAttempts,
            timeoutSec: s.timeoutSec,
            config: s.apiConfig ?? {},
          };
        });
        setSteps(loaded);
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch(() => setMsg("Failed to load workflow"));
  }, [editId, catalog, catByUnit]);

  const stepKeys = useMemo(() => steps.map((s) => s.stepKey), [steps]);

  function addUnit(u: CatalogUnit) {
    const stepKey = slugKey(u.id, stepKeys);
    const isAgent = u.category === "ai_agent";
    const newStep: StepDef = {
      id: crypto.randomUUID(),
      stepKey,
      unitId: u.id,
      unitType: "ai_agent",
      source: "ai",
      category: u.category,
      promptTemplate: isAgent ? "" : undefined,
      dependsOn: [],
      humanInvolved: false,
      maxAttempts: 5,
      timeoutSec: 30,
      config: {},
    };
    setSteps((s) => [...s, newStep]);
    setSelectedId(newStep.id);
    setPicking(false);
  }

  function update(idx: number, patch: Partial<StepDef>) {
    setSteps((s) => s.map((st, i) => (i === idx ? { ...st, ...patch } : st)));
  }

  function remove(idx: number) {
    setSteps((prev) => {
      const removed = prev[idx];
      const removedKey = removed?.stepKey;
      const next = prev
        .filter((_, i) => i !== idx)
        .map((st) =>
          removedKey && st.dependsOn.includes(removedKey)
            ? { ...st, dependsOn: st.dependsOn.filter((d) => d !== removedKey) }
            : st,
        );
      if (removed && removed.id === selectedId) {
        setSelectedId(next[Math.min(idx, next.length - 1)]?.id ?? null);
      }
      return next;
    });
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(
        editId ? `/api/workflows/${editId}` : "/api/workflows",
        {
          method: editId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, steps }),
        },
      );
      const data = await r.json();
      if (!r.ok) {
        setMsg(`Save failed: ${data.error ?? r.status}`);
        return null;
      }
      if (!editId) setEditId(data.id as string); // stay in edit mode after first save
      setMsg(editId ? "Updated" : `Saved workflow ${data.id}`);
      return data.id as string;
    } finally {
      setBusy(false);
    }
  }

  function selectStep(id: string) {
    setSelectedId(id);
    requestAnimationFrame(() => {
      document
        .getElementById(`step-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <div className="builder">
      <h1>{editId ? "Edit workflow" : "Builder"}</h1>
      <p className="muted">
        Add steps top to bottom. Steps run <b>sequentially</b> in this order. A step
        can reference an earlier step&apos;s output as a variable (dashed arrow in the
        diagram).
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {/* left: editor column (2/3) */}
        <div style={{ flex: "2 1 0", minWidth: 320 }}>
          <div className="card">
            <label>Workflow name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {steps.length === 0 && (
            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                No steps yet. Click <b>+ Add step</b> below to pick your first node.
              </p>
            </div>
          )}

          {steps.map((s, idx) =>
            s.id === selectedId ? (
              <StepEditor
                key={s.id}
                step={s}
                idx={idx}
                priorSteps={steps.slice(0, idx)}
                onChange={(patch) => update(idx, patch)}
                onRemove={() => remove(idx)}
              />
            ) : (
              <CollapsedStep
                key={s.id}
                step={s}
                idx={idx}
                onExpand={() => selectStep(s.id)}
                onRemove={() => remove(idx)}
              />
            ),
          )}

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
            <button onClick={save} disabled={busy || steps.length === 0}>
              {editId ? "Update workflow" : "Save workflow"}
            </button>
            <a href="/" className="muted">← All workflows</a>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </div>

        {/* right: diagram column (sticky) */}
        {steps.length > 0 && (
          <div
            style={{
              flex: "0 0 440px",
              minWidth: 440,
              maxWidth: "100%",
              position: "sticky",
              top: 12,
            }}
          >
            <WorkflowDag steps={steps} selectedId={selectedId} onSelect={selectStep} />
          </div>
        )}
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
  const [cat, setCat] = useState<string | null>(null);

  // group units by category, preserving first-seen order
  const groups = useMemo(() => {
    const m = new Map<string, CatalogUnit[]>();
    for (const u of catalog) {
      const arr = m.get(u.category) ?? [];
      arr.push(u);
      m.set(u.category, arr);
    }
    return m;
  }, [catalog]);

  const categories = [...groups.keys()];
  const tools = cat ? groups.get(cat) ?? [] : [];

  // level 1: pick a category
  if (cat === null) {
    return (
      <div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Pick a category</h3>
          <button className="secondary" onClick={onCancel}>Cancel</button>
        </div>
        {categories.length === 0 && (
          <p className="muted">Catalog empty - is the orchestrator running?</p>
        )}
        <div className="grid2">
          {categories.map((c) => (
            <button
              key={c}
              className="secondary"
              style={{ textAlign: "left", padding: "10px 12px" }}
              onClick={() => setCat(c)}
            >
              <div style={{ fontWeight: 600 }}>{categoryLabel(c)}</div>
              <div className="muted" style={{ marginTop: 3 }}>
                {(groups.get(c) ?? []).length} tool
                {(groups.get(c) ?? []).length === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // level 2: pick a tool inside the chosen category
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>{categoryLabel(cat)}</h3>
        <div className="row">
          <button className="secondary" onClick={() => setCat(null)}>← Back</button>
          <button className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
      <div className="grid2">
        {tools.map((u) => (
          <button
            key={u.id}
            className="secondary"
            style={{ textAlign: "left", padding: "10px 12px" }}
            onClick={() => onPick(u)}
          >
            <div style={{ fontWeight: 600 }}>{u.name}</div>
            {u.description && (
              <div className="muted" style={{ marginTop: 3 }}>{u.description}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Point on a rectangle's border from its center along (dx,dy), pushed out by gap. */
function borderPoint(
  cx: number, cy: number, dx: number, dy: number,
  hw: number, hh: number, gap: number,
): [number, number] {
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty) + gap;
  return [cx + dx * t, cy + dy * t];
}

/** Read-only DAG view: nodes laid out in a grid (4 per row), click to jump. */
function WorkflowDag({
  steps,
  selectedId,
  onSelect,
}: {
  steps: StepDef[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const NW = 168, NH = 50, HGAP = 52, VGAP = 44, PAD = 14, COLS = 2;

  const layout = useMemo(() => {
    // grid: fill left-to-right, wrap after COLS, in step order
    const pos = new Map<string, { x: number; y: number }>();
    steps.forEach((s, i) => {
      pos.set(s.stepKey, {
        x: PAD + (i % COLS) * (NW + HGAP),
        y: PAD + Math.floor(i / COLS) * (NH + VGAP),
      });
    });
    const usedCols = Math.min(COLS, Math.max(1, steps.length));
    const rows = Math.max(1, Math.ceil(steps.length / COLS));
    const width = PAD * 2 + usedCols * (NW + HGAP) - HGAP;
    const height = PAD * 2 + rows * (NH + VGAP) - VGAP;
    return { pos, width, height };
  }, [steps]);

  const { pos, width, height } = layout;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Diagram</h2>
        <span className="muted">solid = run order · dashed = variable ref</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg width={width} height={height} style={{ display: "block", maxWidth: "none" }}>
          <defs>
            <marker
              id="dag-arrow"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
            </marker>
            <marker
              id="dag-ref"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {/* edges: connect each step to the next in order (sequence chain) */}
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
              <path
                key={`${s.stepKey}->${next.stepKey}`}
                d={`M ${sx} ${sy} L ${ex} ${ey}`}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1.25}
                markerEnd="url(#dag-arrow)"
              />
            );
          })}
          {/* extra edges: dashed data-flow for referenced prior-step outputs.
              Skip when the ref is the immediate predecessor (the solid chain
              arrow already connects them). */}
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
                <path
                  key={`ref-${dep}->${s.stepKey}`}
                  d={`M ${sx} ${sy} L ${ex} ${ey}`}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.25}
                  strokeDasharray="4 3"
                  markerEnd="url(#dag-ref)"
                />
              );
            }),
          )}
          {/* nodes */}
          {steps.map((s) => {
            const p = pos.get(s.stepKey);
            if (!p) return null;
            const accent = s.category === "parser" ? "var(--ok)" : "var(--accent)";
            const stroke = s.humanInvolved ? "var(--warn)" : accent;
            const isSel = s.id === selectedId;
            return (
              <g
                key={s.id}
                transform={`translate(${p.x}, ${p.y})`}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(s.id)}
              >
                <rect
                  width={NW} height={NH} rx={8}
                  fill={isSel ? "var(--panel)" : "var(--panel2)"}
                  stroke={stroke} strokeWidth={isSel ? 1.5 : 0.75}
                />
                <text x={12} y={20} fill="var(--text)" fontSize={13} fontWeight={600}>
                  {s.stepKey.length > 20 ? s.stepKey.slice(0, 19) + "…" : s.stepKey}
                </text>
                <text x={12} y={38} fill="var(--muted)" fontSize={11}>
                  {categoryLabel(s.category)}
                  {s.humanInvolved ? " · human" : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** Compact row for a non-selected step. Click to expand its config. */
function CollapsedStep({
  step,
  idx,
  onExpand,
  onRemove,
}: {
  step: StepDef;
  idx: number;
  onExpand: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="step-card"
      id={`step-${step.id}`}
      style={{ cursor: "pointer", padding: "10px 14px" }}
      onClick={onExpand}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          <b>#{idx + 1} {step.stepKey}</b>
          <span className="tag">{categoryLabel(step.category)}</span>
          {step.dependsOn.length > 0 && (
            <span className="muted" style={{ marginLeft: 6 }}>
              uses {step.dependsOn.join(", ")}
            </span>
          )}
          {step.humanInvolved && <span className="tag">human</span>}
        </span>
        <div className="row">
          <button className="secondary" onClick={(e) => { e.stopPropagation(); onExpand(); }}>
            Edit
          </button>
          <button className="danger" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/** Variables a step can reference: the outputs of steps it depends on. */
type Variable = { ref: string; label: string; hint: string };

function variablesFor(step: StepDef, priorSteps: StepDef[]): Variable[] {
  const depSet = new Set(step.dependsOn);
  const out: Variable[] = [];
  for (const dep of priorSteps) {
    if (!depSet.has(dep.stepKey)) continue;
    out.push({ ref: `${dep.stepKey}.output`, label: `${dep.stepKey}.output`, hint: "full output" });
    if (dep.category === "ai_agent") {
      out.push({
        ref: `${dep.stepKey}.output.text`,
        label: `${dep.stepKey}.output.text`,
        hint: "AI reply text",
      });
    } else if (dep.category === "parser") {
      out.push({
        ref: `${dep.stepKey}.output.total_rows`,
        label: `${dep.stepKey}.output.total_rows`,
        hint: "total parsed rows",
      });
    }
  }
  return out;
}

function StepEditor({
  step,
  idx,
  priorSteps,
  onChange,
  onRemove,
}: {
  step: StepDef;
  idx: number;
  priorSteps: StepDef[];
  onChange: (patch: Partial<StepDef>) => void;
  onRemove: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const priorKeys = priorSteps.map((s) => s.stepKey);
  const variables = variablesFor(step, priorSteps);
  const isAgent = step.category === "ai_agent";
  const isParser = step.category === "parser";
  const cfg = step.config ?? {};

  function setConfig(patch: Record<string, unknown>) {
    onChange({ config: { ...cfg, ...patch } });
  }

  function toggleDep(k: string) {
    const has = step.dependsOn.includes(k);
    const dependsOn = has
      ? step.dependsOn.filter((d) => d !== k)
      : [...step.dependsOn, k];
    // if a dependency is removed, drop any {{k...}} variables that no longer resolve
    let promptTemplate = step.promptTemplate;
    if (has && promptTemplate) {
      promptTemplate = promptTemplate.replace(
        new RegExp(`\\{\\{\\s*${k}(\\.[^}]*)?\\}\\}`, "g"),
        "",
      );
    }
    onChange({ dependsOn, promptTemplate });
  }

  /** Insert a {{ref}} at the caret (or append) and keep focus. */
  function insertRef(ref: string) {
    const token = `{{${ref}}}`;
    const ta = taRef.current;
    const cur = step.promptTemplate ?? "";
    if (!ta) {
      onChange({ promptTemplate: cur + token });
      return;
    }
    const start = ta.selectionStart ?? cur.length;
    const end = ta.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    onChange({ promptTemplate: next });
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  // behavior preset (ai_agent only), with system_prompt/user_prompt preserved
  const preset = cfg.stuck
    ? "stuck"
    : typeof cfg.simulate_incomplete === "number" && cfg.simulate_incomplete > 0
      ? "reask"
      : "normal";

  function setPreset(p: string) {
    const { stuck: _s, simulate_incomplete: _n, ...rest } = cfg;
    if (p === "normal") setConfigReplace({ ...rest, simulate_incomplete: 0 });
    else if (p === "reask") setConfigReplace({ ...rest, simulate_incomplete: 2 });
    else if (p === "stuck") setConfigReplace({ ...rest, stuck: true });
  }
  function setConfigReplace(next: Record<string, unknown>) {
    onChange({ config: next });
  }

  return (
    <div className="step-card" id={`step-${step.id}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>
          #{idx + 1} {step.stepKey}
          <span className="tag">{categoryLabel(step.category)}</span>
          <span className="tag">{step.unitId}</span>
        </h3>
        <button className="danger" onClick={onRemove}>Remove</button>
      </div>

      <label>Step key (name used in variables like {`{{key.output}}`})</label>
      <input
        value={step.stepKey}
        onChange={(e) => onChange({ stepKey: e.target.value })}
      />

      <label>Use outputs of (adds their variables + a dashed arrow; order is unchanged)</label>
      <div className="row">
        {priorKeys.length === 0 && (
          <span className="muted">first step - no earlier output to use</span>
        )}
        {priorKeys.map((k) => (
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

      {isAgent && (
        <>
          <label>System prompt</label>
          <textarea
            value={String(cfg.system_prompt ?? "")}
            onChange={(e) => setConfig({ system_prompt: e.target.value })}
            placeholder="You are a helpful assistant that..."
            style={{ minHeight: 48 }}
          />

          <label>User prompt</label>
          <div className="muted" style={{ marginBottom: 6 }}>
            Click a variable below to insert it; at run time each {`{{...}}`} is
            replaced with the real output.
          </div>
          {variables.length > 0 ? (
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="muted">Insert:</span>
              {variables.map((v) => (
                <button
                  key={v.ref}
                  className="secondary"
                  title={v.hint}
                  style={{ fontFamily: "ui-monospace, monospace" }}
                  onClick={() => insertRef(v.ref)}
                >
                  {`{{${v.label}}}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ marginBottom: 6 }}>
              No variables yet. Check a step under <b>Depends on</b> above to use its
              output here.
            </div>
          )}
          <textarea
            ref={taRef}
            value={step.promptTemplate ?? ""}
            onChange={(e) => onChange({ promptTemplate: e.target.value })}
            placeholder={
              variables[0]
                ? `Summarize {{${variables[0].ref}}}`
                : "What should this agent do?"
            }
          />

          <label>Behavior (for testing the orchestrator)</label>
          <div className="row">
            {[
              ["normal", "Normal (done first try)"],
              ["reask", "Simulate re-ask (2x not done)"],
              ["stuck", "Stuck (never done -> timeout)"],
            ].map(([val, lbl]) => (
              <label key={val} className="row" style={{ margin: 0 }}>
                <input
                  type="radio"
                  name={`preset-${step.id}`}
                  style={{ width: "auto" }}
                  checked={preset === val}
                  onChange={() => setPreset(val)}
                />
                <span>{lbl}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {isParser && (
        <div className="muted" style={{ marginTop: 6 }}>
          No config. Reads every sheet of the Excel file uploaded in the chat and
          packs it into one JSON (<code>output.sheets</code>,{" "}
          <code>output.total_rows</code>).
        </div>
      )}

      <div className="grid2">
        <div>
          <label>Max attempts (re-ask limit)</label>
          <input
            type="number"
            min={1}
            value={step.maxAttempts}
            onChange={(e) => onChange({ maxAttempts: Number(e.target.value) })}
          />
        </div>
        <div>
          <label>Timeout (sec)</label>
          <input
            type="number"
            min={1}
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
        <span>Human involved (pause the run after this step for review)</span>
      </label>
    </div>
  );
}
