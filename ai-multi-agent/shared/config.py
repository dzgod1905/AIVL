"""Central env/config for the ai-multi-agent package."""
from __future__ import annotations

import json
import logging
import os

log = logging.getLogger("shared.config")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# Orchestrator persistence, SEPARATE from the web's Neon DB.
# If ORCH_DATABASE_URL is set (a local Postgres OR a dedicated Neon project),
# db.py uses Postgres. Otherwise it falls back to the SQLite file below.
ORCH_DATABASE_URL = os.getenv("ORCH_DATABASE_URL", "").strip()
SQLITE_PATH = os.getenv("SQLITE_PATH", "orchestrator.db")

AUTOMATION_SERVER_URL = os.getenv("AUTOMATION_SERVER_URL", "http://localhost:8002")

# ---- security -------------------------------------------------------------
# Shared-secret bearer tokens. Empty => auth DISABLED (local dev only). In any
# multi-machine / shared deployment these MUST be set (see docs/security.md).
#   API_TOKEN            : callers (web) must present it to the orchestrator.
#   AUTOMATION_API_TOKEN : the orchestrator presents it to automation-server.
API_TOKEN = os.getenv("ORCH_API_TOKEN", "").strip()
AUTOMATION_API_TOKEN = os.getenv("AUTOMATION_API_TOKEN", "").strip()

# Max decoded size of an uploaded .xlsx (bytes). Guards excel_reader against
# zip-bomb / oversized uploads that would OOM a worker. Default 10 MiB.
MAX_XLSX_BYTES = int(os.getenv("MAX_XLSX_BYTES", str(10 * 1024 * 1024)))

# Default number of times an agent reports done=false before done=true (per run+step).
DEFAULT_SIMULATE_INCOMPLETE = int(os.getenv("DEFAULT_SIMULATE_INCOMPLETE", "1"))

# Orchestrator dispatch default (fallback max_attempts when a step omits it).
DEFAULT_MAX_ATTEMPTS = int(os.getenv("DEFAULT_MAX_ATTEMPTS", "5"))

# Delay between re-asks when an agent reports done=false.
REASK_DELAY_SEC = float(os.getenv("REASK_DELAY_SEC", "0.5"))

# Simulated work time for the dummy AI Agent (seconds, per attempt).
AI_AGENT_DELAY_SEC = float(os.getenv("AI_AGENT_DELAY_SEC", "20"))

# Simulated work time for the Excel Reader (seconds, per attempt). Makes the
# node visibly "busy" in the DAG panel while testing.
EXCEL_READER_DELAY_SEC = float(os.getenv("EXCEL_READER_DELAY_SEC", "20"))

# ---- real LLM calls (optional) --------------------------------------------
# If at least one usable key is configured in AI_AGENT_KEYS, ai_agent makes a
# REAL model call instead of the dummy echo. Any call that errors (bad key,
# network, rate limit, empty completion) falls through to the next key; if every
# key fails, or the pool is empty, ai_agent uses the dummy reply, so a run never
# breaks on a misconfigured key.
#
#   AI_AGENT_KEYS : JSON array of entries. Each entry needs ALL four fields:
#       {"provider": "anthropic"|"openai", "api_key": "...",
#        "base_url": "https://...", "model": "..."}
#     - provider decides the request/parse shape. "openai" also covers any
#       OpenAI-compatible endpoint (Groq, OpenRouter, ...) via base_url.
#     - base_url has no trailing slash (e.g. https://api.anthropic.com/v1,
#       https://api.openai.com/v1, https://api.groq.com/openai/v1).
#   An entry missing any field is dropped (logged). Empty / invalid => empty
#   pool => ai_agent stays dummy.
# Cap on generated tokens for a real call.
AI_AGENT_MAX_TOKENS = int(os.getenv("AI_AGENT_MAX_TOKENS", "1024"))
# httpx timeout (sec) for a real LLM call. NB: the orchestrator also bounds a
# step by its own timeoutSec (ar.get). For real calls raise the step Timeout in
# the builder above the model's latency, or the step gets cut off and re-asked.
AI_AGENT_HTTP_TIMEOUT = float(os.getenv("AI_AGENT_HTTP_TIMEOUT", "60"))


def _normalize_key_entry(raw: dict) -> dict | None:
    """Validate one AI_AGENT_KEYS entry. All four fields required. None if unusable."""
    provider = str(raw.get("provider", "")).strip().lower()
    api_key = str(raw.get("api_key", "")).strip()
    model = str(raw.get("model", "") or "").strip()
    base_url = str(raw.get("base_url", "") or "").strip().rstrip("/")
    if provider not in ("anthropic", "openai") or not api_key or not model or not base_url:
        return None
    return {"provider": provider, "api_key": api_key, "model": model, "base_url": base_url}


def _load_agent_keys() -> list[dict]:
    """Key pool for ai_agent from AI_AGENT_KEYS (JSON array). Each item is
    normalized; bad items are dropped (logged). Empty / invalid => empty list,
    which makes ai_agent stay dummy (no single-key fallback)."""
    raw = os.getenv("AI_AGENT_KEYS", "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("AI_AGENT_KEYS must be a JSON array")
    except Exception as exc:
        log.warning("AI_AGENT_KEYS invalid (%s) -> dummy", exc)
        return []
    out: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        entry = _normalize_key_entry(item)
        if entry:
            out.append(entry)
    if not out:
        log.warning("AI_AGENT_KEYS parsed but no usable entries -> dummy")
    return out


# Parsed once at import. Empty list => ai_agent stays dummy.
AI_AGENT_KEYS: list[dict] = _load_agent_keys()

# Catalog units, grouped by category for the builder. name -> queue.
# ai_agent  : runs a prompt (system + user) from config.
# excel_reader (parser): reads an Excel file into rows.
AGENTS = {
    "ai_agent": "queue:ai_agent",
    "excel_reader": "queue:excel_reader",
}
