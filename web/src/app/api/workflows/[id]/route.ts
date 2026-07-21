import { NextRequest, NextResponse } from "next/server";
import { eq, asc, and, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { hasCycle } from "@/lib/graph";
import type { StepDef } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET a workflow with its steps (for builder load + run building).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const [wf] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, params.id));
  if (!wf) return NextResponse.json({ error: "not found" }, { status: 404 });

  const steps = await db
    .select()
    .from(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, params.id))
    .orderBy(asc(schema.workflowSteps.order));

  return NextResponse.json({ workflow: wf, steps });
}

// PUT: update name + replace all steps. Same validation as create.
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = (await req.json()) as { name: string; steps: StepDef[] };
  const name = (body.name ?? "").trim();
  if (!name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json({ error: "name and steps required" }, { status: 400 });
  }

  const [wf] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, params.id));
  if (!wf) return NextResponse.json({ error: "not found" }, { status: 404 });

  // reject a name already taken by a DIFFERENT workflow
  const [dup] = await db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.name, name), ne(schema.workflows.id, params.id)));
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

  await db.update(schema.workflows)
    .set({ name })
    .where(eq(schema.workflows.id, params.id));

  // replace steps
  await db.delete(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, params.id));
  await db.insert(schema.workflowSteps).values(
    body.steps.map((s, i) => ({
      workflowId: params.id,
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

  return NextResponse.json({ id: params.id });
}

// DELETE: remove a workflow, its steps, and its run metadata.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await db.delete(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, params.id));
  await db.delete(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, params.id));
  await db.delete(schema.workflows)
    .where(eq(schema.workflows.id, params.id));
  return NextResponse.json({ ok: true });
}
