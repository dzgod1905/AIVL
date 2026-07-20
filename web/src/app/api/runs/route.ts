import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { AI_MULTI_AGENT_URL, orchHeaders } from "@/lib/services";

export const dynamic = "force-dynamic";

// POST { workflowId, input? } -> build orchestrator payload from saved steps,
// call orchestrator POST /runs, persist run metadata, return orchestrator runId.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    workflowId: string;
    sessionId?: string;
    input?: Record<string, unknown>;
  };
  if (!body.workflowId) {
    return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  }

  const steps = await db
    .select()
    .from(schema.workflowSteps)
    .where(eq(schema.workflowSteps.workflowId, body.workflowId))
    .orderBy(asc(schema.workflowSteps.order));

  if (steps.length === 0) {
    return NextResponse.json({ error: "workflow has no steps" }, { status: 400 });
  }

  const payload = {
    workflowId: body.workflowId,
    input: body.input ?? {},
    steps: steps.map((s) => ({
      stepKey: s.stepKey,
      unitId: s.unitId,
      unitType: s.unitType,
      source: s.source,
      promptTemplate: s.promptTemplate ?? undefined,
      dependsOn: s.dependsOn ?? [],
      humanInvolved: s.humanInvolved,
      maxAttempts: s.maxAttempts,
      timeoutSec: s.timeoutSec,
      config: (s.apiConfig ?? {}) as Record<string, unknown>,
    })),
  };

  const r = await fetch(`${AI_MULTI_AGENT_URL}/runs`, {
    method: "POST",
    headers: orchHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json(
      { error: "orchestrator rejected run", detail: text },
      { status: 502 },
    );
  }
  const { runId } = (await r.json()) as { runId: string };

  await db.insert(schema.workflowRuns).values({
    workflowId: body.workflowId,
    sessionId: body.sessionId ?? null,
    input: body.input ?? {},
    orchestratorRunId: runId,
    status: "running",
  });

  return NextResponse.json({ runId });
}
