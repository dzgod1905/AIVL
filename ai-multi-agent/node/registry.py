"""Unit registry: import every tool so Celery registers its task, and map
unitId -> celery task for the eager (in-process) dispatch path.

CATEGORIES documents how the units are grouped in code (matching the builder's
UI categories). The UI catalog itself is served by orchestrator/app.py.
"""
from __future__ import annotations

from node.ai_agent import ai_agent
from node.parser import excel_reader

# category -> unit ids
CATEGORIES = {
    "ai_agent": ["ai_agent"],
    "parser": ["excel_reader"],
}

# unitId -> celery task
TASK_BY_AGENT = {
    "ai_agent": ai_agent.run,
    "excel_reader": excel_reader.run,
}
