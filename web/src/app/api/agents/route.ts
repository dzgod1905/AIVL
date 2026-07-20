import { NextResponse } from "next/server";
import { AI_MULTI_AGENT_URL, orchHeaders } from "@/lib/services";

export const dynamic = "force-dynamic";

// Proxy the orchestrator's per-agent busy/idle snapshot (observability).
export async function GET() {
  try {
    const r = await fetch(`${AI_MULTI_AGENT_URL}/agents`, {
      cache: "no-store",
      headers: orchHeaders(),
    });
    if (!r.ok) return NextResponse.json([]);
    return NextResponse.json(await r.json());
  } catch {
    return NextResponse.json([]);
  }
}
