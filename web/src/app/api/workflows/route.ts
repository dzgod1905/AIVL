import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { hasCycle } from "@/lib/graph";
import type { StepDef } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET: list workflows (newest first)
export async function GET() {
  const rows = await db
    .select()
    .from(schema.workflows)
    .orderBy(desc(schema.workflows.createdAt));
  return NextResponse.json(rows);
}

// POST: save a workflow + its steps. Rejects dependsOn cycles.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { name: string; steps: StepDef[] };
  const name = (body.name ?? "").trim();
  if (!name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "name and steps required" }, { status: 400 });
  }

  // reject a name already taken by another workflow
  const [dup] = await db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(eq(schema.workflows.name, name));
  if (dup) {
    return NextResponse.json(
      { error: `a workflow named "${name}" already exists` },
      { status: 409 },
    );
  }

  const keys = body.steps.map((s) => s.stepKey);
  if (new Set(keys).size !== keys.length) {
    return NextResponse.json({ error: "duplicate stepKey" }, { status: 400 });
  }
  // every dependsOn must reference an existing stepKey
  const keySet = new Set(keys);
  for (const s of body.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!keySet.has(d)) {
        return NextResponse.json(
          { error: `step ${s.stepKey} dependsOn unknown ${d}` },
          { status: 400 },
        );
      }
    }
  }
  if (hasCycle(body.steps)) {
    return NextResponse.json({ error: "dependency cycle detected" }, { status: 400 });
  }

  const [wf] = await db
    .insert(schema.workflows)
    .values({ name })
    .returning();

  await db.insert(schema.workflowSteps).values(
    body.steps.map((s, i) => ({
      workflowId: wf.id,
      order: i,
      stepKey: s.stepKey,
      unitId: s.unitId,
      unitType: s.unitType,
      source: s.source,
      promptTemplate: s.promptTemplate ?? null,
      apiConfig: s.config ?? {},
      dependsOn: s.dependsOn ?? [],
      humanInvolved: s.humanInvolved ?? false,
      maxAttempts: s.maxAttempts ?? 5,
      timeoutSec: s.timeoutSec ?? 30,
    })),
  );

  return NextResponse.json({ id: wf.id });
}
