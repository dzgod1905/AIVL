"""Self-Healing agent. Peer agent; runs on queue:self_healing."""
from __future__ import annotations

from typing import Any

from shared.celery_app import celery_app
from agents.base import run_step

NAME = "self_healing"


@celery_app.task(name="agents.self_healing")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    return run_step(NAME, payload)
