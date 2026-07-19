/**
 * Seed demo workflows (acceptance criteria mục 10).
 * Run: DATABASE_URL=... npm run db:seed  (after db:push)
 */
import "dotenv/config";
import { db, schema } from "./index";

type Step = {
  stepKey: string;
  unitId: string;
  humanInvolved?: boolean;
  dependsOn?: string[];
  promptTemplate?: string;
  config?: Record<string, unknown>;
  maxAttempts?: number;
  timeoutSec?: number;
};

async function seedWorkflow(name: string, steps: Step[]) {
  const [wf] = await db.insert(schema.workflows).values({ name }).returning();
  await db.insert(schema.workflowSteps).values(
    steps.map((s, i) => ({
      workflowId: wf.id,
      order: i,
      stepKey: s.stepKey,
      unitId: s.unitId,
      unitType: "ai_agent",
      source: "ai",
      promptTemplate: s.promptTemplate ?? null,
      contextMapping: {},
      apiConfig: s.config ?? {},
      dependsOn: s.dependsOn ?? [],
      humanInvolved: s.humanInvolved ?? false,
      maxAttempts: s.maxAttempts ?? 5,
      timeoutSec: s.timeoutSec ?? 30,
    })),
  );
  console.log(`seeded "${name}" -> ${wf.id}`);
}

async function main() {
  // A. Linear with human pause. Planner also re-asks once (simulate_incomplete default 1).
  await seedWorkflow("Demo Linear (human pause)", [
    { stepKey: "parser", unitId: "parser" },
    {
      stepKey: "planner",
      unitId: "planner",
      dependsOn: ["parser"],
      humanInvolved: true,
      promptTemplate: "From {{parser.output}}, build a step-by-step plan.",
    },
    { stepKey: "execution", unitId: "execution", dependsOn: ["planner"] },
  ]);

  // B. Branch: Verification & Report run in parallel after Execution; Self-Healing after both.
  await seedWorkflow("Demo Branch (parallel)", [
    { stepKey: "execution", unitId: "execution" },
    { stepKey: "verification", unitId: "verification", dependsOn: ["execution"] },
    { stepKey: "report", unitId: "report", dependsOn: ["execution"] },
    { stepKey: "self_healing", unitId: "self_healing", dependsOn: ["verification", "report"] },
  ]);

  // C. Timeout: execution stuck (always done=false) -> failed at maxAttempts/timeoutSec.
  await seedWorkflow("Demo Timeout (stuck agent)", [
    { stepKey: "parser", unitId: "parser" },
    {
      stepKey: "execution",
      unitId: "execution",
      dependsOn: ["parser"],
      config: { stuck: true },
      maxAttempts: 3,
      timeoutSec: 5,
    },
  ]);

  console.log("seed done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
