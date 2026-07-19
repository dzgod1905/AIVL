"""Aggregator so Celery's include=["agents.tasks"] registers all 6 agent tasks."""
from __future__ import annotations

from agents import (  # noqa: F401
    parser,
    planner,
    execution,
    verification,
    report,
    self_healing,
)

# task name -> celery task
TASK_BY_AGENT = {
    "parser": parser.run,
    "planner": planner.run,
    "execution": execution.run,
    "verification": verification.run,
    "report": report.run,
    "self_healing": self_healing.run,
}
