"""Shared behavior for dummy tool units (Celery tasks).

Each unit is a Celery task. On invoke it returns:
    { "input": <input received>, "agent": "<name>", "done": <bool>, "output": {...} }

`build_output(input_obj, conf, attempt)` lets each unit shape its own domain
output (an AI reply, parsed rows, ...).

Simulated long-running (for AI agents): based on `attempt` (counted per run+step
by the orchestrator), the unit reports done=false for the first N calls
(config.simulate_incomplete, default cfg.DEFAULT_SIMULATE_INCOMPLETE) then
done=true. This is exactly the case that proves the orchestrator's
re-ask-when-not-done loop. `config.stuck=true` -> always done=false (verifies the
maxAttempts/timeoutSec cutoff, no infinite loop). `always_done=True` -> a
deterministic code tool (e.g. a parser) that finishes on the first attempt.
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from shared import config as cfg

BuildOutput = Callable[[dict[str, Any], dict[str, Any], int], Any]


def run_step(
    agent_name: str,
    payload: dict[str, Any],
    build_output: Optional[BuildOutput] = None,
    always_done: bool = False,
) -> dict[str, Any]:
    input_obj = payload.get("input", {})
    attempt = int(payload.get("attempt", 1))
    conf = payload.get("config", {}) or {}

    if always_done:
        done = True
    else:
        stuck = bool(conf.get("stuck", False))
        n_incomplete = int(conf.get("simulate_incomplete", cfg.DEFAULT_SIMULATE_INCOMPLETE))
        # done=false for the first N attempts, then done=true.
        done = False if stuck else attempt > n_incomplete

    if build_output is not None:
        output = build_output(input_obj, conf, attempt)
    else:
        output = {
            "agent": agent_name,
            "summary": f"{agent_name} processed input (attempt {attempt})",
            "echo": input_obj,
        }

    return {
        "input": input_obj,
        "agent": agent_name,
        "done": done,
        "attempt": attempt,
        "output": output,
    }
