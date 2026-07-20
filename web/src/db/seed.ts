/**
 * Seed demo workflows.
 * Run: DATABASE_URL=... npm run db:seed  (after db:push)
 *
 * Uses only the units the orchestrator catalog actually serves
 * (see ai-multi-agent/orchestrator/app.py _UNITS): `excel_reader` (parser) and
 * `ai_agent` (prompt runner). Any other unitId is rejected by POST /runs.
 */
import "dotenv/config";
import { db, schema } from "./index";

type Step = {
  stepKey: string;
  unitId: "ai_agent" | "excel_reader";
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
      unitType: "ai_agent" as const,
      source: "ai" as const,
      promptTemplate: s.promptTemplate ?? null,
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
  // A. Linear with human pause. The AI step re-asks once (simulate_incomplete
  //    default 1) then pauses for human review before the run completes.
  await seedWorkflow("Demo Linear (human pause)", [
    { stepKey: "excel", unitId: "excel_reader" },
    {
      stepKey: "summary",
      unitId: "ai_agent",
      dependsOn: ["excel"],
      humanInvolved: true,
      promptTemplate: "Summarize this data: {{excel.output}}",
    },
  ]);

  // B. Chain: parse -> plan -> report, each AI step references the prior output.
  await seedWorkflow("Demo Chain (parse -> plan -> report)", [
    { stepKey: "excel", unitId: "excel_reader" },
    {
      stepKey: "plan",
      unitId: "ai_agent",
      dependsOn: ["excel"],
      promptTemplate: "From {{excel.output}}, build a step-by-step plan.",
    },
    {
      stepKey: "report",
      unitId: "ai_agent",
      dependsOn: ["plan"],
      promptTemplate: "Write a report for this plan: {{plan.output}}",
    },
  ]);

  // C. Re-ask x3: the AI step reports done=false 3 times before done=true.
  await seedWorkflow("Demo Re-ask (x3)", [
    {
      stepKey: "draft",
      unitId: "ai_agent",
      config: { simulate_incomplete: 3 },
      maxAttempts: 8,
      timeoutSec: 30,
    },
  ]);

  // D. Timeout: the AI step is stuck (always done=false) -> failed at
  //    maxAttempts / timeoutSec (proves the re-ask loop does not hang).
  await seedWorkflow("Demo Timeout (stuck agent)", [
    { stepKey: "excel", unitId: "excel_reader" },
    {
      stepKey: "stuck",
      unitId: "ai_agent",
      dependsOn: ["excel"],
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
