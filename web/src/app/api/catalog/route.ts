import { NextResponse } from "next/server";
import { AI_MULTI_AGENT_URL, AUTOMATION_SERVER_URL } from "@/lib/services";

export const dynamic = "force-dynamic";

async function fetchCatalog(base: string, source: "ai" | "automation") {
  try {
    const r = await fetch(`${base}/catalog`, { cache: "no-store" });
    if (!r.ok) return [];
    const items = (await r.json()) as Record<string, unknown>[];
    return items.map((it) => ({ ...it, source }));
  } catch {
    return [];
  }
}

export async function GET() {
  // Fetch both catalogs in parallel and merge (spec mục 5.1).
  const [ai, automation] = await Promise.all([
    fetchCatalog(AI_MULTI_AGENT_URL, "ai"),
    fetchCatalog(AUTOMATION_SERVER_URL, "automation"),
  ]);
  return NextResponse.json([...ai, ...automation]);
}
