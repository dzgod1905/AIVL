import { NextResponse } from "next/server";
import { AI_MULTI_AGENT_URL, orchHeaders } from "@/lib/services";

export const dynamic = "force-dynamic";

// Catalog = AI service units only, grouped client-side by `category`.
export async function GET() {
  try {
    const r = await fetch(`${AI_MULTI_AGENT_URL}/catalog`, {
      cache: "no-store",
      headers: orchHeaders(),
    });
    if (!r.ok) return NextResponse.json([]);
    const items = (await r.json()) as Record<string, unknown>[];
    return NextResponse.json(items.map((it) => ({ ...it, source: "ai" })));
  } catch {
    return NextResponse.json([]);
  }
}
