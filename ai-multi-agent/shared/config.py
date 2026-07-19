"""Central env/config for the ai-multi-agent package."""
from __future__ import annotations

import os

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# Separate SQLite file (distinct from the web's Neon DB).
SQLITE_PATH = os.getenv("SQLITE_PATH", "orchestrator.db")

AUTOMATION_SERVER_URL = os.getenv("AUTOMATION_SERVER_URL", "http://localhost:8002")

# Default number of times an agent reports done=false before done=true (per run+step).
DEFAULT_SIMULATE_INCOMPLETE = int(os.getenv("DEFAULT_SIMULATE_INCOMPLETE", "1"))

# Orchestrator dispatch defaults (overridable per step).
DEFAULT_MAX_ATTEMPTS = int(os.getenv("DEFAULT_MAX_ATTEMPTS", "5"))
DEFAULT_TIMEOUT_SEC = int(os.getenv("DEFAULT_TIMEOUT_SEC", "30"))

# Delay between re-asks when an agent reports done=false.
REASK_DELAY_SEC = float(os.getenv("REASK_DELAY_SEC", "0.5"))

# The 6 peer agents. name -> queue.
AGENTS = {
    "parser": "queue:parser",
    "planner": "queue:planner",
    "execution": "queue:execution",
    "verification": "queue:verification",
    "report": "queue:report",
    "self_healing": "queue:self_healing",
}
