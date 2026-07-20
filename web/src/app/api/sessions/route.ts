import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

// GET /api/sessions?workflowId=... -> sessions for a workflow (newest first),
// each with runCount + latest run status for the list UI.
export async function GET(req: NextRequest) {
  const workflowId = req.nextUrl.searchParams.get("workflowId");
  if (!workflowId) {
    return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.workflowId, workflowId))
    .orderBy(desc(schema.sessions.createdAt));

  const runs = await db
    .select({
      sessionId: schema.workflowRuns.sessionId,
      status: schema.workflowRuns.status,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, workflowId))
    .orderBy(desc(schema.workflowRuns.createdAt));

  const byS = new Map<string, { count: number; lastStatus: string }>();
  for (const r of runs) {
    if (!r.sessionId) continue;
    const cur = byS.get(r.sessionId);
    if (cur) cur.count += 1;
    else byS.set(r.sessionId, { count: 1, lastStatus: r.status });
  }

  return NextResponse.json(
    rows.map((s) => ({
      ...s,
      runCount: byS.get(s.id)?.count ?? 0,
      lastStatus: byS.get(s.id)?.lastStatus ?? null,
    })),
  );
}

// POST /api/sessions { workflowId, title? } -> create a session.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { workflowId: string; title?: string };
  if (!body.workflowId) {
    return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  }

  const [wf] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, body.workflowId));
  if (!wf) return NextResponse.json({ error: "workflow not found" }, { status: 404 });

  let title = body.title?.trim();
  if (!title) {
    const existing = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.workflowId, body.workflowId));
    title = `Session ${existing.length + 1}`;
  }

  const [s] = await db
    .insert(schema.sessions)
    .values({ workflowId: body.workflowId, title })
    .returning();

  return NextResponse.json({ id: s.id, title: s.title });
}
