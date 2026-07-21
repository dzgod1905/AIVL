export type UnitType = "ai_agent" | "automation_tool";
export type UnitSource = "ai" | "automation";

// A user-configurable setting a tool declares in its Python SPEC["params"].
// The builder renders these generically, so adding a tool never needs UI edits.
export interface ParamSpec {
  key: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "enum";
  default: unknown;
  // required = always shown, cannot be removed (fixed row). optional = added via
  // the "+ Add setting" row picker and removable.
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: string[]; // enum only
}

export interface CatalogUnit {
  id: string;
  name: string;
  type: UnitType;
  category: string; // builder grouping: "ai_agent" | "parser" | ...
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  params: ParamSpec[]; // from each tool's SPEC; drives the generic config UI
  configurable: boolean;
  source: UnitSource; // added by /api/catalog
}

export interface StepDef {
  id: string; // stable client-side id (React key); in-memory only, not persisted
  stepKey: string;
  unitId: string;
  unitType: UnitType;
  source: UnitSource;
  category: string; // in-memory only (not persisted); drives the editor UI
  promptTemplate?: string;
  // steps referenced for {{stepKey.output}} variables (not a scheduling dep)
  dependsOn: string[];
  humanInvolved: boolean;
  maxAttempts: number;
  timeoutSec: number;
  config: Record<string, unknown>;
}
