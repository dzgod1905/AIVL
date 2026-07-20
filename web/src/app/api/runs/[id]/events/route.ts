import { NextRequest } from "next/server";
import { AI_MULTI_AGENT_URL, orchHeaders } from "@/lib/services";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Proxy the orchestrator SSE stream down to the browser (solves CORS/auth).
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const upstream = await fetch(`${AI_MULTI_AGENT_URL}/runs/${params.id}/events`, {
    headers: orchHeaders({ accept: "text/event-stream" }),
    signal: req.signal,
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`upstream error ${upstream.status}`, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
