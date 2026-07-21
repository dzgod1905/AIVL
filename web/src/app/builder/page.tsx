"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogUnit, ParamSpec, StepDef } from "@/lib/types";

const CATEGORY_LABEL: Record<string, string> = {
  ai_agent: "AI Agent",
  parser: "Parser",
};

// Re-ask limit and per-step timeout are fixed in code, not user-configurable.
const STEP_MAX_ATTEMPTS = 5;
const STEP_TIMEOUT_SEC = 30;

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

  // unitId -> declared config params (from each tool's SPEC), for the generic
  // param editor. Not persisted in the DB; looked up from the catalog by unitId.
  const paramsByUnit = useMemo(() => {
    const m: Record<string, ParamSpec[]> = {};
    for (const u of catalog) m[u.id] = u.params ?? [];
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
          // Legacy ai_agent steps stored the user prompt in promptTemplate; the
          // builder now edits it as the user_prompt param. Migrate on load.
          let config = s.apiConfig ?? {};
          if (category === "ai_agent" && s.promptTemplate && config.user_prompt === undefined) {
            config = { ...config, user_prompt: s.promptTemplate };
          }
          // legacy split session flags -> one `session` flag
          if (config.session === undefined && (config.session_text || config.session_file)) {
            config = { ...config, session: true };
          }
          if ("session_text" in config || "session_file" in config) {
            const { session_text: _t, session_file: _f, ...rest } = config;
            config = rest;
          }
          // ensure required params (always-present rows) carry a value
          for (const p of paramsByUnit[s.unitId] ?? []) {
            if (p.required && !(p.key in config)) {
              config = { ...config, [p.key]: paramDefault(p) };
            }
          }
          return {
            id: crypto.randomUUID(),
            stepKey: s.stepKey,
            unitId: s.unitId,
            unitType: s.unitType,
            source: s.source,
            category,
            promptTemplate: category === "ai_agent" ? "" : undefined,
            dependsOn: s.dependsOn ?? [],
            humanInvolved: s.humanInvolved,
            maxAttempts: STEP_MAX_ATTEMPTS,
            timeoutSec: STEP_TIMEOUT_SEC,
            config,
          };
        });
        setSteps(loaded);
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch(() => setMsg("Failed to load workflow"));
  }, [editId, catalog, catByUnit, paramsByUnit]);

  const stepKeys = useMemo(() => steps.map((s) => s.stepKey), [steps]);

  function addUnit(u: CatalogUnit) {
    const stepKey = slugKey(u.id, stepKeys);
    const isAgent = u.category === "ai_agent";
    // required params are always present -> seed them with their defaults so the
    // config carries them from the start (they cannot be added/removed later).
    const config: Record<string, unknown> = {};
    for (const p of u.params ?? []) {
      if (p.required) config[p.key] = paramDefault(p);
    }
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
      maxAttempts: STEP_MAX_ATTEMPTS,
      timeoutSec: STEP_TIMEOUT_SEC,
      config,
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
                params={paramsByUnit[s.unitId] ?? []}
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
  // session (the chat text/file) is insertable into prompts when enabled
  if (step.config?.session) {
    out.push({ ref: "session.text", label: "session.text", hint: "typed request text" });
    out.push({ ref: "session.file", label: "session.file", hint: "uploaded file name" });
  }
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

function paramDefault(p: ParamSpec): unknown {
  return p.default ?? (p.type === "boolean" ? false : p.type === "number" ? 0 : "");
}

/** Value cell for one param row, rendered by the param's type. Text params get a
 * textarea and report focus so the {{variable}} buttons can target them. */
function ParamValue({
  p,
  value,
  onValue,
  onFocusText,
}: {
  p: ParamSpec;
  value: unknown;
  onValue: (v: unknown) => void;
  onFocusText: (el: HTMLTextAreaElement, key: string) => void;
}) {
  if (p.type === "boolean") {
    return (
      <label className="row" style={{ margin: 0 }}>
        <input
          type="checkbox"
          style={{ width: "auto" }}
          checked={!!value}
          onChange={(e) => onValue(e.target.checked)}
        />
        <span className="muted">on</span>
      </label>
    );
  }
  if (p.type === "enum") {
    return (
      <select value={String(value ?? "")} onChange={(e) => onValue(e.target.value)}>
        {(p.options ?? []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (p.type === "text") {
    return (
      <textarea
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={p.placeholder ?? ""}
        style={{ minHeight: 48, width: "100%" }}
        onFocus={(e) => onFocusText(e.currentTarget, p.key)}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  }
  return (
    <input
      type={p.type === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={p.placeholder ?? ""}
      style={{ width: "100%" }}
      onChange={(e) =>
        onValue(p.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)
      }
    />
  );
}

/** Config editor with two kinds of params:
 *  - required: always shown as fixed rows (no picker, no Remove). Seeded with
 *    their default when the step is created / loaded.
 *  - optional: added via the "+ Add setting" row (a picker dropdown + value +
 *    Remove). Rows are the optional params currently present in `cfg`, so
 *    add/remove/switch just writes/clears a config key (no hidden local state).
 * For ai_agent, user_prompt is a required param; system_prompt is optional. */
function ParamEditor({
  params,
  cfg,
  onChange,
  variables,
}: {
  params: ParamSpec[];
  cfg: Record<string, unknown>;
  onChange: (nextCfg: Record<string, unknown>) => void; // full replace
  variables: Variable[];
}) {
  const lastFocused = useRef<{ el: HTMLTextAreaElement; key: string } | null>(null);

  if (params.length === 0) return null;

  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const activeOptional = optional.filter((p) => p.key in cfg); // declaration order
  const usedKeys = new Set(activeOptional.map((p) => p.key));
  const unused = optional.filter((p) => !usedKeys.has(p.key));
  const byKey = (k: string) => optional.find((p) => p.key === k);

  // text params that can receive a {{variable}} insert (required are always here)
  const textParams = [...required, ...activeOptional].filter((p) => p.type === "text");

  function addRow() {
    const p = unused[0];
    if (p) onChange({ ...cfg, [p.key]: paramDefault(p) });
  }
  function removeRow(key: string) {
    const next = { ...cfg };
    delete next[key];
    onChange(next);
  }
  function switchKey(oldKey: string, newKey: string) {
    if (newKey === oldKey) return;
    const p = byKey(newKey);
    const next = { ...cfg };
    delete next[oldKey];
    next[newKey] = p ? paramDefault(p) : "";
    onChange(next);
  }
  function setValue(key: string, v: unknown) {
    onChange({ ...cfg, [key]: v });
  }

  function insertRef(ref: string) {
    const token = `{{${ref}}}`;
    const f = lastFocused.current;
    if (f) {
      const cur = String(cfg[f.key] ?? "");
      const start = f.el.selectionStart ?? cur.length;
      const end = f.el.selectionEnd ?? cur.length;
      const next = cur.slice(0, start) + token + cur.slice(end);
      setValue(f.key, next);
      requestAnimationFrame(() => {
        f.el.focus();
        const pos = start + token.length;
        f.el.setSelectionRange(pos, pos);
      });
      return;
    }
    // no textarea focused: append to the first text param present, if any
    const firstText = textParams[0];
    if (firstText) setValue(firstText.key, String(cfg[firstText.key] ?? "") + token);
  }

  const onFocusText = (el: HTMLTextAreaElement, key: string) =>
    (lastFocused.current = { el, key });

  return (
    <div style={{ marginTop: 8 }}>
      <label>Settings</label>

      {variables.length > 0 && textParams.length > 0 && (
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="muted">Insert into focused prompt:</span>
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
      )}

      {/* required params: fixed rows, no picker, no Remove */}
      {required.map((p) => (
        <div
          key={p.key}
          style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}
        >
          <div style={{ flex: "0 0 180px" }}>
            <div style={{ fontWeight: 600 }}>{p.label}</div>
            <div className="muted">required</div>
          </div>
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <ParamValue
              p={p}
              value={p.key in cfg ? cfg[p.key] : paramDefault(p)}
              onValue={(v) => setValue(p.key, v)}
              onFocusText={onFocusText}
            />
            {p.description && (
              <div className="muted" style={{ marginTop: 2 }}>{p.description}</div>
            )}
          </div>
        </div>
      ))}

      {/* optional params: picker + value + Remove */}
      {activeOptional.map((p) => {
        const options = [p, ...unused];
        return (
          <div
            key={p.key}
            style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}
          >
            <select
              value={p.key}
              style={{ flex: "0 0 180px" }}
              onChange={(e) => switchKey(p.key, e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <div style={{ flex: "1 1 0", minWidth: 0 }}>
              <ParamValue
                p={p}
                value={cfg[p.key]}
                onValue={(v) => setValue(p.key, v)}
                onFocusText={onFocusText}
              />
              {p.description && (
                <div className="muted" style={{ marginTop: 2 }}>{p.description}</div>
              )}
            </div>
            <button className="danger" onClick={() => removeRow(p.key)}>Remove</button>
          </div>
        );
      })}

      {optional.length > 0 && (
        <button className="secondary" onClick={addRow} disabled={unused.length === 0}>
          + Add setting
        </button>
      )}
    </div>
  );
}

function StepEditor({
  step,
  idx,
  priorSteps,
  params,
  onChange,
  onRemove,
}: {
  step: StepDef;
  idx: number;
  priorSteps: StepDef[];
  params: ParamSpec[];
  onChange: (patch: Partial<StepDef>) => void;
  onRemove: () => void;
}) {
  const priorKeys = priorSteps.map((s) => s.stepKey);
  const variables = variablesFor(step, priorSteps);
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
    // if a dependency is removed, drop any {{k...}} refs from the prompt params
    let config = step.config;
    if (has && config) {
      const re = new RegExp(`\\{\\{\\s*${k}(\\.[^}]*)?\\}\\}`, "g");
      const strip = (v: unknown) => (typeof v === "string" ? v.replace(re, "") : v);
      config = { ...config, user_prompt: strip(config.user_prompt), system_prompt: strip(config.system_prompt) };
    }
    onChange({ dependsOn, config });
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

      <label>Input from (sources feeding this step; a step output also adds its variables + a dashed arrow)</label>
      <div className="row">
        <label className="row" style={{ margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={!!cfg.session}
            onChange={(e) => setConfig({ session: e.target.checked })}
          />
          <span>session</span>
        </label>
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

      {isParser && (
        <div className="muted" style={{ marginTop: 6 }}>
          Reads the Excel file into one JSON (<code>output.sheets</code>,{" "}
          <code>output.total_rows</code>). Set <b>Take input from</b> to{" "}
          <b>session</b> in Settings below to feed it the file uploaded in the chat.
        </div>
      )}

      <ParamEditor params={params} cfg={cfg} onChange={setConfigReplace} variables={variables} />

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
