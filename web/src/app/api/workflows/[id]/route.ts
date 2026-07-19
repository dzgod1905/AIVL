import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "@/db";

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
