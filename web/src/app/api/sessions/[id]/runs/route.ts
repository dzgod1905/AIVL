import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

// GET /api/sessions/[id]/runs -> runs of a session (oldest first) for
// reconstructing chat history. Detailed step IO lives in the orchestrator;
// the client fetches it per run via /api/runs/[orchestratorRunId].
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const runs = await db
    .select({
      id: schema.workflowRuns.id,
      orchestratorRunId: schema.workflowRuns.orchestratorRunId,
      input: schema.workflowRuns.input,
      status: schema.workflowRuns.status,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.sessionId, params.id))
    .orderBy(asc(schema.workflowRuns.createdAt));

  return NextResponse.json(runs);
}
