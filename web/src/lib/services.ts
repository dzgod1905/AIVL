// Backend service base URL (server-side only). The web talks only to the
// orchestrator; automation-server is reached by the orchestrator, never here.
export const AI_MULTI_AGENT_URL =
  process.env.AI_MULTI_AGENT_URL ?? "http://localhost:8001";

// Shared-secret bearer token for the orchestrator. Empty => no header (dev).
// Must match ORCH_API_TOKEN on the ai-multi-agent side in any real deployment.
const ORCH_API_TOKEN = process.env.ORCH_API_TOKEN ?? "";

// Merge the orchestrator bearer header into a fetch() headers object.
// Server-side only (this token must never reach the browser).
export function orchHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (ORCH_API_TOKEN) h["authorization"] = `Bearer ${ORCH_API_TOKEN}`;
  return h;
}
