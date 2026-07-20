import { NextRequest, NextResponse } from "next/server";
import { AI_MULTI_AGENT_URL, orchHeaders } from "@/lib/services";

export const dynamic = "force-dynamic";

// Proxy orchestrator GET /runs/{id} (status + per-step input/output).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const r = await fetch(`${AI_MULTI_AGENT_URL}/runs/${params.id}`, {
    cache: "no-store",
    headers: orchHeaders(),
  });
  const data = await r.json();
  return NextResponse.json(data, { status: r.status });
}
