export type UnitType = "ai_agent" | "automation_tool";
export type UnitSource = "ai" | "automation";

export interface CatalogUnit {
  id: string;
  name: string;
  type: UnitType;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  configurable: boolean;
  source: UnitSource; // added by /api/catalog merge
}

export interface StepDef {
  stepKey: string;
  unitId: string;
  unitType: UnitType;
  source: UnitSource;
  promptTemplate?: string;
  contextMapping: Record<string, string>;
  dependsOn: string[];
  humanInvolved: boolean;
  maxAttempts: number;
  timeoutSec: number;
  config: Record<string, unknown>;
}
