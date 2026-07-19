"""Verification agent. Peer agent; runs on queue:verification."""
from __future__ import annotations

from typing import Any

from shared.celery_app import celery_app
from agents.base import run_step

NAME = "verification"


@celery_app.task(name="agents.verification")
def run(payload: dict[str, Any]) -> dict[str, Any]:
    return run_step(NAME, payload)
