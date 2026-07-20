import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

// GET /api/sessions/[id] -> session + its workflow name (for the chat header).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const [s] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, params.id));
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [wf] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, s.workflowId));

  return NextResponse.json({ session: s, workflowName: wf?.name ?? s.workflowId });
}

// DELETE /api/sessions/[id] -> remove a session and its run metadata.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await db
    .delete(schema.workflowRuns)
    .where(eq(schema.workflowRuns.sessionId, params.id));
  await db.delete(schema.sessions).where(eq(schema.sessions.id, params.id));
  return NextResponse.json({ ok: true });
}
