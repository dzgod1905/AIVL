"""Unit registry: the ONE file to edit when adding a tool.

Add a tool in two steps (see docs/adding-a-tool.md):
  1. Create node/<category>/<tool>.py with a module-level SPEC dict and a Celery
     `run` task.
  2. Import its module here and append it to _MODULES (one line).

Everything else is DERIVED from each module's SPEC below, so no other file needs
editing:
  - UNITS         -> orchestrator /catalog listing (mục 4 contract)
  - TASK_BY_AGENT -> unitId -> Celery task for the eager (in-process) dispatch path
  - CATEGORIES    -> category -> [unitId] grouping (matches the builder UI)
  - UNIT_IDS      -> validation set for POST /runs
  - QUEUES        -> queue names the worker subscribes to (worker.sh)
Queue routing itself is derived from the task name in shared/celery_app.py
(node.<id> -> queue:<id>), so it needs no entry here either.
"""
from __future__ import annotations

from types import ModuleType

from node.ai_agent import ai_agent
from node.parser import excel_reader

# The single edit point: list every tool module here (one line per tool).
_MODULES: list[ModuleType] = [ai_agent, excel_reader]

# ---- derived tables (do not edit by hand) ---------------------------------
UNITS: list[dict] = []                     # catalog specs
TASK_BY_AGENT: dict = {}                    # unitId -> Celery task
CATEGORIES: dict[str, list[str]] = {}       # category -> [unitId]

for _mod in _MODULES:
    _spec = _mod.SPEC
    _uid = _spec["id"]
    if _uid in TASK_BY_AGENT:
        raise ValueError(f"duplicate unit id in registry: {_uid!r}")
    UNITS.append(_spec)
    TASK_BY_AGENT[_uid] = _mod.run
    CATEGORIES.setdefault(_spec["category"], []).append(_uid)

UNIT_IDS: set[str] = {u["id"] for u in UNITS}
QUEUES: list[str] = [f"queue:{u['id']}" for u in UNITS]
