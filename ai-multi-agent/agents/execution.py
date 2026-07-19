"""Execution agent. Peer agent; runs on queue:execution."""
from __future__ import annotations

from typing import Any

from shared.celery_app import celery_app
from agents.base import run_step

NAME = "execution"


@celery_app.task(name="agents.execution")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    return run_step(NAME, payload)
