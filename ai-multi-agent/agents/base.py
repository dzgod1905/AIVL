"""Shared behavior for the 6 dummy peer agents.

Each agent is a Celery task. On invoke it returns:
    { "input": <input received>, "agent": "<name>", "done": <bool> }

Simulated long-running: based on `attempt` (counted per run+step by the
orchestrator and passed in), the agent reports done=false for the first N calls
(config.simulate_incomplete, default 1) then done=true. This is exactly the case
that proves the orchestrator's re-ask-when-not-done loop works.

Stuck mode: config.stuck=true makes the agent ALWAYS return done=false, so the
orchestrator's maxAttempts/timeoutSec cutoff can be verified (no infinite loop).
"""
from __future__ import annotations

from typing import Any

from shared import config as cfg


def run_step(agent_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    input_obj = payload.get("input", {})
    attempt = int(payload.get("attempt", 1))
    conf = payload.get("config", {}) or {}

    stuck = bool(conf.get("stuck", False))
    n_incomplete = int(conf.get("simulate_incomplete", cfg.DEFAULT_SIMULATE_INCOMPLETE))

    if stuck:
        done = False
    else:
        # done=false for the first N attempts, then done=true.
        done = attempt > n_incomplete

    return {
        "input": input_obj,
        "agent": agent_name,
        "done": done,
        "attempt": attempt,
        # dummy domain output so downstream steps have something to reference
        "output": {
            "agent": agent_name,
            "summary": f"{agent_name} processed input (attempt {attempt})",
            "echo": input_obj,
        },
    }
