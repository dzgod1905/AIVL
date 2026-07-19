import { NextRequest, NextResponse } from "next/server";
import { AI_MULTI_AGENT_URL } from "@/lib/services";

export const dynamic = "force-dynamic";

// Proxy orchestrator POST /runs/{id}/resume (human-in-the-loop Continue).
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const r = await fetch(`${AI_MULTI_AGENT_URL}/runs/${params.id}/resume`, {
    method: "POST",
    cache: "no-store",
  });
  const data = await r.json();
  return NextResponse.json(data, { status: r.status });
}
