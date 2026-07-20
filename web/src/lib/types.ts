export type UnitType = "ai_agent" | "automation_tool";
export type UnitSource = "ai" | "automation";

export interface CatalogUnit {
  id: string;
  name: string;
  type: UnitType;
  category: string; // builder grouping: "ai_agent" | "parser" | ...
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
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
